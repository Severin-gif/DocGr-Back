import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DocGridAdminGuard } from './docgrid-admin.guard';
import { DocGridUserAdminService } from './docgrid-user-admin.service';
@Controller('internal/docgrid/admin/users')
@UseGuards(DocGridAdminGuard)
export class DocGridUserAdminController {
  constructor(private readonly users:DocGridUserAdminService) {}
  @Get() list(@Query('q') q?:string,@Query('status') status?:string,@Query('page') page?:string) {return this.users.list(q,status,page);}
  @Get(':id/history') history(@Param('id') id:string) {return this.users.history(id);}
  @Post(':id/access') access(@Param('id') id:string,@Body() body:unknown,@Headers('x-docgrid-admin-actor') actor:string) {return this.users.setAccess(id,body,actor);}
}
