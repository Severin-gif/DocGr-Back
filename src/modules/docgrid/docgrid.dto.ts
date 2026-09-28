import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Matches, Min, MinLength } from 'class-validator';

export class CreateDocGridRepositoryDto {
  @ApiProperty({ maxLength: 120 })
  @IsString() @MinLength(1) @MaxLength(120) name!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class UpdateDocGridRepositoryDto {
  @ApiProperty({ maxLength: 120 })
  @IsString() @MinLength(1) @MaxLength(120) name!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class CreateDocGridArtifactDto {
  @ApiProperty({ maxLength: 180 })
  @IsString() @MinLength(1) @MaxLength(180) title!: string;

  @ApiPropertyOptional({ maxLength: 500, default: '/' })
  @IsOptional() @IsString() @MaxLength(500) path?: string;

  @ApiPropertyOptional({ maxLength: 2_000_000, default: '' })
  @IsOptional() @IsString() @MaxLength(2_000_000) content?: string;
}

export class CreateDocGridBranchDto {
  @ApiProperty({ maxLength: 80 })
  @IsString() @MinLength(1) @MaxLength(80) name!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID() fromBranchId?: string;

  @ApiPropertyOptional({ enum: ['WORK','AI','COUNTERPARTY'] })
  @IsOptional() @IsIn(['WORK','AI','COUNTERPARTY']) kind?: 'WORK' | 'AI' | 'COUNTERPARTY';
}

export class SaveDocGridBranchDocumentDto {
  @IsOptional() @IsUUID() targetBranchId?: string;
  @IsOptional() @IsInt() @Min(1) targetRevision?: number;
  @ApiProperty({ maxLength: 2_000_000 })
  @IsString() @MaxLength(2_000_000) content!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt() @Min(1) revision!: number;

  @ApiProperty({ maxLength: 300 })
  @IsString() @MinLength(1) @MaxLength(300) message!: string;
}

export class CreateDocGridReviewDto {
  @IsUUID() projectId!: string;
  @IsUUID() sourceBranchId!: string;
  @IsUUID() targetBranchId!: string;
  @IsString() @MinLength(1) @MaxLength(180) title!: string;
  @IsOptional() @IsString() @MaxLength(4000) body?: string;
}

export class CreateDocGridIssueDto {
  @IsOptional() @IsIn(['ISSUE','DECISION']) kind?: 'ISSUE' | 'DECISION';
  @IsString() @MinLength(1) @MaxLength(180) title!: string;
  @IsOptional() @IsString() @MaxLength(20_000) body?: string;
  @IsOptional() @IsUUID() linkedDocumentId?: string;
}

export class DecideDocGridIssueDto {
  @IsString() @MinLength(1) @MaxLength(20_000) resolution!: string;
}

export class CloseDocGridReviewDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class CreateDocGridReleaseDto {
  @IsUUID() branchId!: string;
  @IsString() @MinLength(1) @MaxLength(64) tag!: string;
  @IsString() @MinLength(1) @MaxLength(180) title!: string;
  @IsOptional() @IsString() @MaxLength(20_000) notes?: string;
}

export class RunDocGridAiReviewDto {
  @IsUUID() sourceBranchId!: string;
  @IsOptional() @IsUUID() targetBranchId?: string;
  @IsOptional() @IsIn(['review','summarize_diff','draft_change'])
  mode?: 'review' | 'summarize_diff' | 'draft_change';
  @IsOptional() @IsString() @MaxLength(4000) instruction?: string;
}

export class DocGridFolderDto { @IsString() @MaxLength(500) path!:string; }
export class DocGridTrashDto { @IsIn(['material','document']) kind!: 'material'|'document'; @IsIn(['trash','restore']) action!: 'trash'|'restore'; }
export class DocGridMemberDto { @IsString() @MaxLength(254) email!:string; @IsIn(['READER','EDITOR','REVIEWER','REMOVE']) role!:string; }
export class DocGridRestoreDto { @IsUUID() commitId!:string; @IsInt() @Min(1) revision!:number; }
export class DocGridCommentDto { @IsString() @MinLength(1) @MaxLength(4000) body!:string; @IsOptional() @IsString() @MaxLength(4000) quote?:string; @IsInt() @Min(1) revision!:number; }

export class DocGridRelocateMaterialDto {
  @IsString() @Matches(/^[0-9a-f]{64}$/) sha256!: string;
  @IsString() @MaxLength(500) fromPath!: string;
  @IsString() @MaxLength(500) path!: string;
}

