import { AiTimeBudgetService } from './ai-time-budget.service';
import { FolderShareService } from './folder-share.service';
import { FolderSharePublicController,FolderShareOwnerController } from './folder-share.controller';
import { CourtPackageService } from './court-package.service';
import { CourtPackageController } from './court-package.controller';
import { ProjectContextService } from './project-context.service';
import { DocGridOcrService } from './docgrid-ocr.service';
import { DiscussionService } from './discussion.service';
import { DiscussionController } from './discussion.controller';
import { AgentOAuthCodeStore } from './agent-oauth.controller';
import { DocGridMaterialStorageService } from './docgrid-material-storage.service';
import {DocGridBackupService} from './docgrid-backup.service';
import { DocumentFileService } from '../document-workflow/document-file.service';
import { S3Service } from '../../common/s3/s3.service';
import { ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { DocGridAdminGuard } from './docgrid-admin.guard';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { DocGridAdminController, DocGridController } from './docgrid.controller';
import { DocGridService } from './docgrid.service';
import { AstraAgentController, AstraHumanController } from './astra/astra.controller';
import { AstraAgentGuard } from './astra/astra-agent.guard';
import { AstraService } from './astra/astra.service';
import { AstraSourcesService } from './astra/astra-sources.service';
import { AstraWorkflowService } from './astra/astra-workflow.service';
import { AstraUploadService } from './astra/astra-upload.service';

@Module({
  imports: [],
  controllers: [FolderSharePublicController,FolderShareOwnerController,CourtPackageController, DiscussionController, DocGridController, DocGridAdminController, AstraAgentController, AstraHumanController],
  providers: [FolderShareService,CourtPackageService,AiTimeBudgetService,ProjectContextService,DocGridOcrService,DiscussionService,DocumentFileService, { provide: S3Service, inject: [ConfigService], useFactory: (config: ConfigService) => new S3Service(new ConfigService(Object.fromEntries(['ENDPOINT', 'BUCKET', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'FORCE_PATH_STYLE'].map(key => [`S3_${key}`, config.get(`DOCGRID_S3_${key}`)])))) }, AgentOAuthCodeStore, DocGridMaterialStorageService, DocGridBackupService, DocGridService, DocGridAdminGuard, DocGridIdentityGuard, AstraAgentGuard, AstraService, AstraSourcesService, AstraWorkflowService, AstraUploadService],
  exports: [DocGridService, AstraService, AgentOAuthCodeStore],
})
export class DocGridModule {}

