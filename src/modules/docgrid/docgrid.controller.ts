import { AstraService } from './astra/astra.service';
import {DocGridBackupService} from './docgrid-backup.service';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { DocGridRelocateMaterialDto,DocGridFolderDto,DocGridTrashDto,DocGridMemberDto,DocGridRestoreDto,DocGridCommentDto } from './docgrid.dto';
import {
  Headers, UploadedFile, UseInterceptors, StreamableFile, Res, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe,
  Post, Put, Query, UseGuards, Delete,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { DocGridAdminGuard } from './docgrid-admin.guard';
import {
  CreateDocGridArtifactDto,
  CreateDocGridBranchDto,
  CreateDocGridIssueDto,
  CreateDocGridRepositoryDto,
  UpdateDocGridRepositoryDto,
  CreateDocGridReleaseDto,
  CreateDocGridReviewDto,
  DecideDocGridIssueDto,
  RunDocGridAiReviewDto,
  SaveDocGridBranchDocumentDto,
} from './docgrid.dto';
import { DOCGRID_PROJECT_MAX_BYTES, DocGridService } from './docgrid.service';

@ApiTags('docgrid')
@ApiBearerAuth()
@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid')
export class DocGridController {
  constructor(private readonly docgrid: DocGridService, private readonly agents: AstraService) {}

  @Post('repositories/:projectId/search')
  search(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() input:unknown){return this.agents.humanSearch(user,project,input);}
  @Get('repositories/:projectId/extraction')
  extraction(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.docgrid.extractionStatus(user,project);}
  @Post('repositories/:projectId/materials/:id/ocr')
  ocr(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string){return this.docgrid.retryOcr(user,project,id);}
  @Get('repositories/:projectId/files')
  files(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Query('trash') trash?:string) {return this.docgrid.files(user,project,trash==='true');}
  @Post('repositories/:projectId/folders')
  folder(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() dto:DocGridFolderDto) {return this.docgrid.addFolder(user,project,dto.path);}
  @Post('repositories/:projectId/materials')
  // There is no separate 10 MB per-file cap: a single upload may use the
  // remaining project quota. Keep an ingress ceiling equal to the project quota
  // so malformed multipart requests cannot grow without bound in memory.
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:DOCGRID_PROJECT_MAX_BYTES,files:1,fields:1}}))
  upload(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@UploadedFile() file:{originalname:string;mimetype:string;buffer:Buffer},@Body('path') path?:string,@Headers('x-request-id') requestId?:string) {return this.docgrid.uploadMaterial(user,project,file,path,requestId);}
  @Post('repositories/:projectId/materials/:id/compare')
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:DOCGRID_PROJECT_MAX_BYTES,files:1,fields:0}}))
  compareMaterial(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@UploadedFile() file:{originalname:string;mimetype:string;buffer:Buffer}){return this.docgrid.compareMaterial(user,project,id,file);}
  @Post('repositories/:projectId/materials/:id/relocate')
  relocate(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Body() dto:DocGridRelocateMaterialDto) {return this.docgrid.relocateMaterial(user,project,id,dto);}
  @Get('repositories/:projectId/materials/:id/text')
  text(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string){return this.docgrid.materialText(user,project,id);}
  @Post('repositories/:projectId/materials/:id/extract')
  extract(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string){return this.docgrid.reextractMaterial(user,project,id);}
  @Get('repositories/:projectId/materials/:id/download')
  async download(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Res({passthrough:true}) response:Response) {
    const file=await this.docgrid.material(user,project,id);
    response.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.title)}`);
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
    return new StreamableFile(Buffer.from(file.bytes),{type:'application/octet-stream'});
  }
  @Post('repositories/:projectId/files/:id/trash')
  trash(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Body() dto:DocGridTrashDto) {return this.docgrid.trashFile(user,project,id,dto.kind,dto.action==='restore');}
  @Post('branches/:branchId/documents/:id/restore')
  restore(@CurrentUser('id') user:string,@Param('branchId',ParseUUIDPipe) branch:string,@Param('id',ParseUUIDPipe) id:string,@Body() dto:DocGridRestoreDto) {return this.docgrid.restoreCommit(user,branch,id,dto.commitId,dto.revision);}
  @Post('reviews/:id/refresh')
  refresh(@CurrentUser('id') user:string,@Param('id',ParseUUIDPipe) id:string) {return this.docgrid.refreshReview(user,id);}
  @Get('repositories/:projectId/members')
  members(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string) {return this.docgrid.members(user,project);}
  @Put('repositories/:projectId/members')
  member(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() dto:DocGridMemberDto) {return this.docgrid.setMember(user,project,dto.email,dto.role);}
  @Get('branches/:branchId/documents/:id/comments')
  comments(@CurrentUser('id') user:string,@Param('branchId',ParseUUIDPipe) branch:string,@Param('id',ParseUUIDPipe) id:string) {return this.docgrid.comments(user,branch,id);}
  @Post('branches/:branchId/documents/:id/comments')
  comment(@CurrentUser('id') user:string,@Param('branchId',ParseUUIDPipe) branch:string,@Param('id',ParseUUIDPipe) id:string,@Body() dto:DocGridCommentDto) {return this.docgrid.addComment(user,branch,id,dto);}
  @Get('repositories/:projectId/judgments/:branchId')
  judgments(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('branchId',ParseUUIDPipe) branch:string) {return this.docgrid.judgments(user,project,branch);}

  @Delete('repositories/:projectId')
  deleteRepository(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.docgrid.deleteRepository(user,project);}

  @Get('repositories')
  repositories(@CurrentUser('id') userId: string) {
    return this.docgrid.listRepositories(userId);
  }

  @Post('repositories')
  createRepository(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateDocGridRepositoryDto,
  ) {
    return this.docgrid.createRepository(userId, dto);
  }

  @Put('repositories/:projectId')
  updateRepository(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateDocGridRepositoryDto,
  ) {
    return this.docgrid.updateRepository(userId, projectId, dto);
  }

  @Post('repositories/:projectId/artifacts')
  createArtifact(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateDocGridArtifactDto,
  ) {
    return this.docgrid.createArtifact(userId, projectId, dto);
  }

  @Get('repositories/:projectId/overview')
  overview(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.docgrid.overview(userId, projectId);
  }

  @Get('repositories/:projectId/branches')
  branches(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.docgrid.listBranches(userId, projectId);
  }

  @Post('repositories/:projectId/branches')
  createBranch(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateDocGridBranchDto,
  ) {
    return this.docgrid.createBranch(userId, projectId, dto);
  }

  @Get('branches/:branchId/documents')
  documents(
    @CurrentUser('id') userId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ) {
    return this.docgrid.listBranchDocuments(userId, branchId);
  }

  @Put('branches/:branchId/documents/:documentId')
  saveBranchDocument(
    @CurrentUser('id') userId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: SaveDocGridBranchDocumentDto,
  ) {
    return this.docgrid.saveBranchDocument(userId, branchId, documentId, dto);
  }

  @Get('branches/:branchId/commits')
  commits(
    @CurrentUser('id') userId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = rawLimit ? Number(rawLimit) : 50;
    return this.docgrid.listCommits(userId, branchId, Number.isFinite(limit) ? limit : 50);
  }

  @Get('commits/:commitId')
  commit(
    @CurrentUser('id') userId: string,
    @Param('commitId', ParseUUIDPipe) commitId: string,
  ) {
    return this.docgrid.getCommit(userId, commitId);
  }

  @Get('branches/:sourceBranchId/compare/:targetBranchId')
  compare(
    @CurrentUser('id') userId: string,
    @Param('sourceBranchId', ParseUUIDPipe) sourceBranchId: string,
    @Param('targetBranchId', ParseUUIDPipe) targetBranchId: string,
  ) {
    return this.docgrid.compare(userId, sourceBranchId, targetBranchId);
  }

  @Get('repositories/:projectId/reviews')
  reviews(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.docgrid.listReviews(userId, projectId);
  }

  @Post('reviews')
  createReview(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateDocGridReviewDto,
  ) {
    return this.docgrid.createReview(userId, dto);
  }

  @Post('reviews/:reviewId/merge')
  @HttpCode(HttpStatus.OK)
  mergeReview(
    @CurrentUser('id') userId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.docgrid.mergeReview(userId, reviewId);
  }

  @Post('reviews/:reviewId/close')
  @HttpCode(HttpStatus.OK)
  closeReview(
    @CurrentUser('id') userId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.docgrid.closeReview(userId, reviewId);
  }

  @Get('repositories/:projectId/issues')
  issues(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.docgrid.listIssues(userId, projectId);
  }

  @Post('repositories/:projectId/issues')
  createIssue(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateDocGridIssueDto,
  ) {
    return this.docgrid.createIssue(userId, projectId, dto);
  }

  @Post('issues/:issueId/decide')
  @HttpCode(HttpStatus.OK)
  decideIssue(
    @CurrentUser('id') userId: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() dto: DecideDocGridIssueDto,
  ) {
    return this.docgrid.decideIssue(userId, issueId, dto);
  }

  @Get('repositories/:projectId/releases')
  releases(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.docgrid.listReleases(userId, projectId);
  }

  @Post('repositories/:projectId/releases')
  createRelease(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateDocGridReleaseDto,
  ) {
    return this.docgrid.createRelease(userId, projectId, dto);
  }

  @Post('repositories/:projectId/ai-review')
  aiReview(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RunDocGridAiReviewDto,
  ) {
    return this.docgrid.runAiReview(userId, projectId, dto);
  }

  @Get('repositories/:projectId/activity')
  activity(
    @CurrentUser('id') userId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = rawLimit ? Number(rawLimit) : 50;
    return this.docgrid.activity(userId, projectId, Number.isFinite(limit) ? limit : 50);
  }
}

@ApiTags('docgrid-admin')
@UseGuards(DocGridAdminGuard)
@Controller('internal/docgrid/admin')
export class DocGridAdminController {
  constructor(private readonly docgrid: DocGridService,private readonly backups:DocGridBackupService) {}
  @Get('backup-status') backupStatus(){return this.backups.status();}
  @Post('backup') backup(){return this.backups.backup();}

  @Get('summary')
  summary() {
    return this.docgrid.adminSummary();
  }

  @Get('events')
  events(@Query('limit') rawLimit?: string) {
    const limit = rawLimit ? Number(rawLimit) : 100;
    return this.docgrid.adminEvents(Number.isFinite(limit) ? limit : 100);
  }
}
