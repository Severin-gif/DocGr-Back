import { Injectable, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
@Injectable()
export class AiTimeBudgetService {
 constructor(private readonly db:PrismaService){}
 limitMs(){const hours=Number(process.env.DOCGRID_AI_MONTHLY_HOURS??1);return Number.isFinite(hours)&&hours>=0&&hours<=1000?Math.floor(hours*3600000):3600000;}
 async status(project:string){const [row]=await this.db.$queryRaw<any[]>`SELECT COALESCE(u.milliseconds,0)::float8 AS used FROM docgrid.workspace_projects p LEFT JOIN docgrid.dg_ai_time_usage u ON u.owner_id=p.owner_id AND u.month=date_trunc('month',now() AT TIME ZONE 'UTC')::date WHERE p.id=${project}::uuid`;const limit=this.limitMs(),used=Number(row?.used||0);return {limitMs:limit,usedMs:used,remainingMs:Math.max(0,limit-used),unit:'model_wait_time',period:'UTC calendar month'};}
 async reserve(project:string){
  const id=randomUUID(),reserved=90000,limit=this.limitMs();
  await this.db.$transaction(async tx=>{
   const [owner]=await tx.$queryRaw<any[]>`SELECT owner_id FROM docgrid.workspace_projects WHERE id=${project}::uuid`;
   if(!owner)throw new Error('Project not found');
   const rows=await tx.$queryRaw<any[]>`INSERT INTO docgrid.dg_ai_time_usage(owner_id,month,milliseconds) SELECT ${owner.owner_id},date_trunc('month',now() AT TIME ZONE 'UTC')::date,${reserved} WHERE ${limit}>=${reserved} ON CONFLICT(owner_id,month) DO UPDATE SET milliseconds=docgrid.dg_ai_time_usage.milliseconds+${reserved} WHERE docgrid.dg_ai_time_usage.milliseconds+${reserved}<=${limit} RETURNING owner_id`;
   if(!rows.length)throw new HttpException({code:'AI_HOURS_EXHAUSTED',message:'Проверка не пройдена: лимит времени ИИ исчерпан.'},429);
   await tx.$executeRaw`INSERT INTO docgrid.dg_ai_time_calls(id,owner_id,month,reserved) VALUES(${id}::uuid,${owner.owner_id},date_trunc('month',now() AT TIME ZONE 'UTC')::date,${reserved})`;
  });
  return {id,started:Date.now()};
 }
 async finish(call:{id:string;started:number}){const elapsed=Math.max(1,Math.min(90000,Date.now()-call.started));await this.db.$transaction(async tx=>{const [row]=await tx.$queryRaw<any[]>`UPDATE docgrid.dg_ai_time_calls SET finished_at=now() WHERE id=${call.id}::uuid AND finished_at IS NULL RETURNING owner_id,month,reserved`;if(row)await tx.$executeRaw`UPDATE docgrid.dg_ai_time_usage SET milliseconds=GREATEST(0,milliseconds-${row.reserved}+${elapsed}) WHERE owner_id=${row.owner_id} AND month=${row.month}::date`;});}
}
