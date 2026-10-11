import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DocGridUserAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: string = '', status: string = 'all', page: string = '1') {
    if (query.length > 320 || !['all', 'active', 'blocked'].includes(status) || !/^[1-9]\d{0,5}$/.test(page)) throw new BadRequestException('Invalid user filter');
    const search = query.trim();
    const where: Prisma.UserWhereInput = {
      ...(search ? { OR: [{email:{contains:search,mode:'insensitive'}}, {name:{contains:search,mode:'insensitive'}}, {id:search}, {externalSubject:search}] } : {}),
      ...(status === 'blocked' ? {accessBlockedAt:{not:null}} : status === 'active' ? {accessBlockedAt:null} : {}),
    };
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({where}),
      this.prisma.user.findMany({where,skip:(Number(page)-1)*50,take:50,orderBy:[{createdAt:'desc'},{id:'asc'}],select:{
        id:true,email:true,name:true,role:true,plan:true,createdAt:true,emailVerifiedAt:true,lastLoginAt:true,
        externalSubject:true,identityProvider:true,accessBlockedAt:true,_count:{select:{workspaceProjects:true}},
      }}),
    ]);
    return {total,page:Number(page),pageSize:50,users:users.map(({_count,...user})=>({...user,projects:_count.workspaceProjects}))};
  }

  async setAccess(id: string, raw: unknown, actor: string) {
    if (!id || id.length > 128 || !actor || actor.length > 200) throw new BadRequestException('Invalid user or administrator');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Invalid body');
    const body = raw as Record<string,unknown>;
    if (Object.keys(body).some(key=>!['blocked','reason'].includes(key)) || typeof body.blocked !== 'boolean' || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) throw new BadRequestException('Specify blocked and a reason (1–500 characters)');
    const blocked=body.blocked, reason=body.reason.trim();
    return this.prisma.$transaction(async tx=>{
      const users=await tx.$queryRaw<{id:string;accessBlockedAt:Date|null}[]>`SELECT id,access_blocked_at AS "accessBlockedAt" FROM docgrid."User" WHERE id=${id} FOR UPDATE`;
      if (!users[0]) throw new NotFoundException('User not found');
      if (!!users[0].accessBlockedAt === blocked) return {id,accessBlockedAt:users[0].accessBlockedAt};
      const user=await tx.user.update({where:{id},data:{accessBlockedAt:blocked?new Date():null},select:{id:true,accessBlockedAt:true}});
      await tx.$executeRaw`INSERT INTO docgrid.dg_user_admin_events(user_id,actor,blocked,reason) VALUES (${id},${actor},${blocked},${reason})`;
      return user;
    });
  }
  async history(id: string) {
    if (!id || id.length > 128) throw new BadRequestException('Invalid user');
    return this.prisma.$queryRaw`SELECT id,actor,blocked,reason,created_at AS "createdAt" FROM docgrid.dg_user_admin_events WHERE user_id=${id} ORDER BY created_at DESC,id DESC LIMIT 100`;
  }
}
