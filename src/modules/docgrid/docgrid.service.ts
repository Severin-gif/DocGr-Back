import { ForbiddenException, BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mergeText } from './docgrid-merge';
import { createHash, randomUUID } from 'node:crypto';
import { extractMaterialText } from './docgrid-material-extraction';
import { DocGridMaterialStorageService, readMaterialBytes } from './docgrid-material-storage.service';
import { PrismaService } from '../../prisma/prisma.service';
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

export const DOCGRID_PROJECT_MAX_BYTES = 500 * 1024 * 1024;

type Db = Prisma.TransactionClient;
type RepoRow = { id: string; name: string; description: string | null; createdAt: Date; updatedAt: Date };
type BranchRow = { id: string; projectId: string; name: string; kind: string; createdBy: string; createdAt: Date; updatedAt: Date };
type BranchDocumentRow = {
  branchId: string;
  documentId: string;
  title: string;
  path: string;
  revision: number;
  content: string;
  headCommitId: string | null;
  workspaceVersion: number | null;
  updatedAt: Date;
};
type ReviewRow = {
  id: string;
  projectId: string;
  sourceBranchId: string;
  targetBranchId: string;
  authorId: string;
  mergedBy: string | null;
  title: string;
  body: string | null;
  status: string;
  sourceSnapshot: Record<string, number>;
  targetSnapshot: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
};

@Injectable()
export class DocGridService {
  private readonly uploadLogger = new Logger('DocGridUpload');
  constructor(private readonly prisma: PrismaService, @Optional() private readonly materialStorage?: DocGridMaterialStorageService) {}

  private async requireRepo(db: Db, ownerId: string, projectId: string, action: 'read' | 'write' | 'merge' | 'owner' = 'read'): Promise<RepoRow> {
    const rows = await db.$queryRaw<RepoRow[]>`
      SELECT p.id, p.name, p.description, p.created_at AS "createdAt", p.updated_at AS "updatedAt"
      FROM docgrid.workspace_projects p
      WHERE p.id = ${projectId}::uuid AND (p.owner_id = ${ownerId} OR EXISTS (
        SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ownerId}
        AND (${action}='read' OR (${action}='write' AND m.role IN ('EDITOR','REVIEWER')) OR (${action}='merge' AND m.role='REVIEWER'))
      )) FOR UPDATE OF p
    `;
    if (!rows[0]) throw new NotFoundException('Проект не найден или недостаточно прав');
    return rows[0];
  }

  private async requireBranch(db: Db, ownerId: string, branchId: string): Promise<BranchRow> {
    const rows = await db.$queryRaw<BranchRow[]>`
      SELECT b.id, b.project_id AS "projectId", b.name, b.kind, b.created_by AS "createdBy",
             b.created_at AS "createdAt", b.updated_at AS "updatedAt"
      FROM docgrid.docgrid_branches b
      JOIN docgrid.workspace_projects p ON p.id = b.project_id
      WHERE b.id = ${branchId}::uuid AND (p.owner_id = ${ownerId} OR EXISTS (SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ownerId}))
      LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundException('Вариант не найден');
    await this.requireRepo(db, ownerId, rows[0].projectId);
    return rows[0];
  }

  private async event(db: Db, projectId: string, actorId: string, eventType: string, entityType: string, entityId: string | null, metadata: unknown = {}) {
    await db.$executeRaw`
      INSERT INTO docgrid.docgrid_events(project_id, actor_id, event_type, entity_type, entity_id, metadata)
      VALUES (${projectId}::uuid, ${actorId}, ${eventType}, ${entityType},
              CASE WHEN ${entityId}::text IS NULL THEN NULL ELSE ${entityId}::uuid END,
              ${JSON.stringify(metadata)}::jsonb)
    `;
  }

  private async ensureMainBranch(db: Db, ownerId: string, projectId: string): Promise<BranchRow> {
    await this.requireRepo(db, ownerId, projectId);
    await db.$executeRaw`
      INSERT INTO docgrid.docgrid_branches(project_id, name, kind, created_by)
      VALUES (${projectId}::uuid, 'main', 'MAIN', ${ownerId})
      ON CONFLICT (project_id, name) DO NOTHING
    `;
    const branches = await db.$queryRaw<BranchRow[]>`
      SELECT id, project_id AS "projectId", name, kind, created_by AS "createdBy",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM docgrid.docgrid_branches
      WHERE project_id = ${projectId}::uuid AND name = 'main'
      LIMIT 1
    `;
    const main = branches[0];
    if (!main) throw new ConflictException('Не удалось создать основной вариант');

    await db.$executeRaw`
      INSERT INTO docgrid.docgrid_branch_documents(branch_id, document_id, revision, content, workspace_version)
      SELECT ${main.id}::uuid, d.id, 1, d.content, d.version
      FROM docgrid.workspace_documents d
      WHERE d.project_id = ${projectId}::uuid
      ON CONFLICT (branch_id, document_id) DO NOTHING
    `;

    return main;
  }

  async createRepository(ownerId: string, dto: CreateDocGridRepositoryDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Название проекта обязательно');
    return this.prisma.$transaction(async tx => {
      const project = await tx.workspaceProject.create({
        data: {
          ownerId,
          name,
          description: dto.description?.trim() || null,
        },
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const main = await this.ensureMainBranch(tx, ownerId, project.id);
      await this.event(tx, project.id, ownerId, 'repository.created', 'repository', project.id, { name, mainBranchId: main.id });
      return { ...project, mainBranchId: main.id };
    });
  }

  async updateRepository(ownerId: string, projectId: string, dto: UpdateDocGridRepositoryDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Название проекта обязательно');
    return this.prisma.$transaction(async tx => {
      await this.requireRepo(tx, ownerId, projectId, 'owner');
      const project = await tx.workspaceProject.update({
        where: { id: projectId },
        data: { name, description: dto.description?.trim() || null },
        select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
      });
      await this.event(tx, projectId, ownerId, 'repository.updated', 'repository', projectId, { name, description: project.description });
      return project;
    });
  }

  async createArtifact(ownerId: string, projectId: string, dto: CreateDocGridArtifactDto) {
    return this.prisma.$transaction(async tx => {
      await this.requireRepo(tx, ownerId, projectId, 'write');
      const main = await this.ensureMainBranch(tx, ownerId, projectId);
      const title = dto.title.trim();
      if (!title) throw new BadRequestException('Название документа обязательно');
      const path = this.cleanPath(dto.path);
      const content = dto.content ?? '';
      const document = await tx.workspaceDocument.create({
        data: {
          projectId,
          title,
          path,
          content,
          versions: {
            create: {
              version: 1,
              content,
              authorId: ownerId,
              message: 'Создан документ',
            },
          },
        },
        select: {
          id: true,
          projectId: true,
          title: true,
          path: true,
          content: true,
          version: true,
          updatedAt: true,
        },
      });
      const hash = this.hashCommit(main.id, document.id, 1, 'Создан документ', content);
      const commits = await tx.$queryRaw<Array<{ id: string; hash: string; createdAt: Date }>>`
        INSERT INTO docgrid.docgrid_commits(project_id, branch_id, document_id, parent_commit_id, author_id, message, before_content, after_content, content_hash)
        VALUES (${projectId}::uuid, ${main.id}::uuid, ${document.id}::uuid, NULL, ${ownerId},
                'Создан документ', '', ${content}, ${hash})
        RETURNING id, content_hash AS hash, created_at AS "createdAt"
      `;
      await tx.$executeRaw`
        INSERT INTO docgrid.docgrid_branch_documents(branch_id, document_id, revision, content, head_commit_id, workspace_version)
        VALUES (${main.id}::uuid, ${document.id}::uuid, 1, ${content}, ${commits[0].id}::uuid, 1)
      `;
      await tx.$executeRaw`UPDATE docgrid.docgrid_branches SET updated_at=CURRENT_TIMESTAMP WHERE id=${main.id}::uuid`;
      await tx.$executeRaw`UPDATE docgrid.workspace_projects SET updated_at=CURRENT_TIMESTAMP WHERE id=${projectId}::uuid`;
      await this.event(tx, projectId, ownerId, 'artifact.created', 'document', document.id, {
        title,
        branch: 'main',
        commitId: commits[0].id,
        hash,
      });
      return { ...document, branchId: main.id, revision: 1, commit: commits[0] };
    });
  }

  async listRepositories(ownerId: string) {
    const repos = await this.prisma.$queryRaw<Array<RepoRow & { documents: bigint; branches: bigint; openReviews: bigint; openIssues: bigint }>>`
      SELECT p.id, p.name, p.description, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
        (SELECT COUNT(*) FROM docgrid.workspace_documents d WHERE d.project_id = p.id) AS documents,
        (SELECT COUNT(*) FROM docgrid.docgrid_branches b WHERE b.project_id = p.id) AS branches,
        (SELECT COUNT(*) FROM docgrid.docgrid_reviews r WHERE r.project_id = p.id AND r.status IN ('OPEN','CONFLICT')) AS "openReviews",
        (SELECT COUNT(*) FROM docgrid.docgrid_issues i WHERE i.project_id = p.id AND i.status = 'OPEN') AS "openIssues"
      FROM docgrid.workspace_projects p
      WHERE (p.owner_id = ${ownerId} OR EXISTS (SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ownerId}))
      ORDER BY p.updated_at DESC
    `;
    return repos.map(r => ({ ...r, documents: Number(r.documents), branches: Number(r.branches), openReviews: Number(r.openReviews), openIssues: Number(r.openIssues) }));
  }

  async overview(ownerId: string, projectId: string) {
    return this.prisma.$transaction(async tx => {
      const repo = await this.requireRepo(tx, ownerId, projectId);
      await this.ensureMainBranch(tx, ownerId, projectId);
      const [branches, reviews, issues, releases, events] = await Promise.all([
        this.listBranchesWithDb(tx, ownerId, projectId),
        this.listReviewsWithDb(tx, ownerId, projectId),
        this.listIssuesWithDb(tx, ownerId, projectId),
        this.listReleasesWithDb(tx, ownerId, projectId),
        this.activityWithDb(tx, ownerId, projectId, 20),
      ]);
      return { repository: repo, branches, reviews, issues, releases, activity: events };
    });
  }

  private async listBranchesWithDb(db: Db, ownerId: string, projectId: string) {
    await this.requireRepo(db, ownerId, projectId);
    const rows = await db.$queryRaw<Array<BranchRow & { documents: bigint; commits: bigint }>>`
      SELECT b.id, b.project_id AS "projectId", b.name, b.kind, b.created_by AS "createdBy",
             b.created_at AS "createdAt", b.updated_at AS "updatedAt",
             (SELECT COUNT(*) FROM docgrid.docgrid_branch_documents bd WHERE bd.branch_id = b.id) AS documents,
             (SELECT COUNT(*) FROM docgrid.docgrid_commits c WHERE c.branch_id = b.id) AS commits
      FROM docgrid.docgrid_branches b
      WHERE b.project_id = ${projectId}::uuid
      ORDER BY CASE WHEN b.name = 'main' THEN 0 ELSE 1 END, b.updated_at DESC
    `;
    return rows.map(r => ({ ...r, documents: Number(r.documents), commits: Number(r.commits) }));
  }

  async listBranches(ownerId: string, projectId: string) {
    return this.prisma.$transaction(async tx => {
      await this.ensureMainBranch(tx, ownerId, projectId);
      return this.listBranchesWithDb(tx, ownerId, projectId);
    });
  }

  async createBranch(ownerId: string, projectId: string, dto: CreateDocGridBranchDto) {
    const name = dto.name.trim();
    if (name.toLowerCase() === 'main') throw new BadRequestException('Основной вариант создаётся автоматически');
    return this.prisma.$transaction(async tx => {
      await this.requireRepo(tx, ownerId, projectId, 'write');
      const main = await this.ensureMainBranch(tx, ownerId, projectId);
      const source = dto.fromBranchId ? await this.requireBranch(tx, ownerId, dto.fromBranchId) : main;
      if (source.projectId !== projectId) throw new NotFoundException('Исходный вариант не относится к проекту');
      const rows = await tx.$queryRaw<BranchRow[]>`
        INSERT INTO docgrid.docgrid_branches(project_id, name, kind, created_by)
        VALUES (${projectId}::uuid, ${name}, ${dto.kind ?? 'WORK'}, ${ownerId})
        RETURNING id, project_id AS "projectId", name, kind, created_by AS "createdBy",
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `.catch((error: unknown) => {
        if (String(error).includes('docgrid_branches_project_name_key')) throw new ConflictException('Вариант с таким именем уже существует');
        throw error;
      });
      const branch = rows[0];
      await tx.$executeRaw`
        INSERT INTO docgrid.docgrid_branch_documents(branch_id, document_id, revision, content, head_commit_id, workspace_version, base_content, base_branch_id)
        SELECT ${branch.id}::uuid, document_id, revision, content, head_commit_id, workspace_version, content, ${source.id}::uuid
        FROM docgrid.docgrid_branch_documents
        WHERE branch_id = ${source.id}::uuid
      `;
      await this.event(tx, projectId, ownerId, 'branch.created', 'branch', branch.id, { name, from: source.name, kind: branch.kind });
      return branch;
    });
  }

  async listBranchDocuments(ownerId: string, branchId: string) {
    return this.prisma.$transaction(async tx => {
      const branch = await this.requireBranch(tx, ownerId, branchId);
      if (branch.name === 'main') await this.ensureMainBranch(tx, ownerId, branch.projectId);
      return tx.$queryRaw<BranchDocumentRow[]>`
        SELECT bd.branch_id AS "branchId", bd.document_id AS "documentId", d.title, d.path,
               bd.revision, bd.content, bd.head_commit_id AS "headCommitId",
               bd.workspace_version AS "workspaceVersion", bd.updated_at AS "updatedAt"
        FROM docgrid.docgrid_branch_documents bd
        JOIN docgrid.workspace_documents d ON d.id = bd.document_id
        WHERE bd.branch_id = ${branchId}::uuid AND d.docgrid_deleted_at IS NULL
        ORDER BY d.path, d.title
      `;
    });
  }

  private hashCommit(branchId: string, documentId: string, revision: number, message: string, content: string) {
    return createHash('sha256').update([branchId, documentId, String(revision), message, content].join('\0')).digest('hex');
  }

  private async syncMainWorkspace(
    tx: Prisma.TransactionClient,
    ownerId: string,
    branchDocument: BranchDocumentRow,
    content: string,
    message: string,
  ): Promise<number> {
    const docs = await tx.$queryRaw<Array<{ version: number }>>`
      SELECT d.version
      FROM docgrid.workspace_documents d
      JOIN docgrid.workspace_projects p ON p.id = d.project_id
      WHERE d.id = ${branchDocument.documentId}::uuid AND (p.owner_id = ${ownerId} OR EXISTS (SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ownerId}))
      FOR UPDATE
    `;
    const workspace = docs[0];
    if (!workspace) throw new NotFoundException('Документ не найден');
    if (branchDocument.workspaceVersion !== null && workspace.version !== branchDocument.workspaceVersion) {
      throw new ConflictException('Основной вариант изменён вне DocGrid. Обновите документ перед сохранением.');
    }
    const next = workspace.version + 1;
    await tx.$executeRaw`
      UPDATE docgrid.workspace_documents
      SET content = ${content}, version = ${next}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${branchDocument.documentId}::uuid
    `;
    await tx.$executeRaw`
      INSERT INTO docgrid.workspace_document_versions(document_id, version, content, author_id, message)
      VALUES (${branchDocument.documentId}::uuid, ${next}, ${content}, ${ownerId}, ${message})
    `;
    return next;
  }

  async saveBranchDocument(ownerId: string, branchId: string, documentId: string, dto: SaveDocGridBranchDocumentDto) {
    return this.prisma.$transaction(async tx => {
      const branch = await this.requireBranch(tx, ownerId, branchId);
      await this.requireRepo(tx, ownerId, branch.projectId, 'write');
      if (branch.name === 'main') throw new ForbiddenException('Основной вариант изменяется только через PR. Создайте рабочий вариант.');
      const rows = await tx.$queryRaw<BranchDocumentRow[]>`
        SELECT bd.branch_id AS "branchId", bd.document_id AS "documentId", d.title, d.path,
               bd.revision, bd.content, bd.head_commit_id AS "headCommitId",
               bd.workspace_version AS "workspaceVersion", bd.updated_at AS "updatedAt"
        FROM docgrid.docgrid_branch_documents bd
        JOIN docgrid.workspace_documents d ON d.id = bd.document_id
        WHERE bd.branch_id = ${branchId}::uuid AND bd.document_id = ${documentId}::uuid AND d.docgrid_deleted_at IS NULL
        FOR UPDATE
      `;
      const current = rows[0];
      if (!current) throw new NotFoundException('Документ отсутствует в варианте');
      if (current.revision !== dto.revision) throw new ConflictException('Вариант уже изменён. Обновите документ.');
      if (dto.targetBranchId) {
        const target = await this.requireBranch(tx, ownerId, dto.targetBranchId);
        if (target.projectId !== branch.projectId || target.id === branchId) throw new BadRequestException('Неверный целевой вариант');
        const targetRows = await tx.$queryRaw<Array<{content:string;revision:number}>>`SELECT content,revision FROM docgrid.docgrid_branch_documents WHERE branch_id=${target.id}::uuid AND document_id=${documentId}::uuid FOR UPDATE`;
        if (!targetRows[0] || targetRows[0].revision !== dto.targetRevision) throw new ConflictException('CONFLICT: целевой вариант изменился');
        await tx.$executeRaw`UPDATE docgrid.docgrid_branch_documents SET base_content=${targetRows[0].content},base_branch_id=${target.id}::uuid WHERE branch_id=${branchId}::uuid AND document_id=${documentId}::uuid`;
        await this.event(tx,branch.projectId,ownerId,'conflict.resolved','document',documentId,{sourceBranchId:branchId,targetBranchId:target.id,targetRevision:dto.targetRevision});
      }
      if (current.content === dto.content && !dto.targetBranchId) return { ...current, commit: null };

      const nextRevision = current.revision + 1;
      const hash = this.hashCommit(branchId, documentId, nextRevision, dto.message.trim(), dto.content);
      const commits = await tx.$queryRaw<Array<{ id: string; hash: string; createdAt: Date }>>`
        INSERT INTO docgrid.docgrid_commits(project_id, branch_id, document_id, parent_commit_id, author_id, message, before_content, after_content, content_hash)
        VALUES (${branch.projectId}::uuid, ${branchId}::uuid, ${documentId}::uuid,
                ${current.headCommitId}::uuid, ${ownerId}, ${dto.message.trim()},
                ${current.content}, ${dto.content}, ${hash})
        RETURNING id, content_hash AS hash, created_at AS "createdAt"
      `;
      let workspaceVersion = current.workspaceVersion;
      if (branch.name === 'main') workspaceVersion = await this.syncMainWorkspace(tx, ownerId, current, dto.content, dto.message.trim());

      await tx.$executeRaw`
        UPDATE docgrid.docgrid_branch_documents
        SET content = ${dto.content}, revision = ${nextRevision}, head_commit_id = ${commits[0].id}::uuid,
            workspace_version = ${workspaceVersion}, updated_at = CURRENT_TIMESTAMP
        WHERE branch_id = ${branchId}::uuid AND document_id = ${documentId}::uuid
      `;
      await tx.$executeRaw`UPDATE docgrid.docgrid_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ${branchId}::uuid`;
      await tx.$executeRaw`UPDATE docgrid.workspace_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ${branch.projectId}::uuid`;
      await this.event(tx, branch.projectId, ownerId, 'commit.created', 'commit', commits[0].id, { branch: branch.name, documentId, revision: nextRevision, hash });
      return { ...current, content: dto.content, revision: nextRevision, headCommitId: commits[0].id, workspaceVersion, commit: commits[0] };
    });
  }

  async listCommits(ownerId: string, branchId: string, limit = 50) {
    await this.requireBranch(this.prisma, ownerId, branchId);
    const safeLimit = Math.max(1, Math.min(100, limit));
    return this.prisma.$queryRaw`
      SELECT c.id, c.project_id AS "projectId", c.branch_id AS "branchId", c.document_id AS "documentId",
             c.parent_commit_id AS "parentCommitId", c.author_id AS "authorId", c.message,
             c.content_hash AS hash, c.created_at AS "createdAt", d.title AS "documentTitle"
      FROM docgrid.docgrid_commits c
      JOIN docgrid.workspace_documents d ON d.id = c.document_id
      WHERE c.branch_id = ${branchId}::uuid
      ORDER BY c.created_at DESC
      LIMIT ${safeLimit}
    `;
  }

  async getCommit(ownerId: string, commitId: string) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT c.id, c.project_id AS "projectId", c.branch_id AS "branchId", c.document_id AS "documentId",
             c.parent_commit_id AS "parentCommitId", c.author_id AS "authorId", c.message,
             c.before_content AS "beforeContent", c.after_content AS "afterContent",
             c.content_hash AS hash, c.created_at AS "createdAt", d.title AS "documentTitle"
      FROM docgrid.docgrid_commits c
      JOIN docgrid.workspace_projects p ON p.id = c.project_id
      JOIN docgrid.workspace_documents d ON d.id = c.document_id
      WHERE c.id = ${commitId}::uuid AND (p.owner_id = ${ownerId} OR EXISTS (SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ownerId}))
      LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundException('Коммит не найден');
    return rows[0];
  }

  private isSourceChange(row: { sourceRevision: number | null; sourceContent: string | null; targetContent: string | null; baseContent?: string | null }) {
    // Artifact deletion is intentionally not part of DocGrid v1.
    return row.sourceRevision !== null && row.sourceContent !== row.targetContent && (row.baseContent == null || row.sourceContent !== row.baseContent);
  }

  private summarize(before: string | null, after: string | null) {
    if (before === after) return { changed: false, addedLines: 0, removedLines: 0 };
    const a = (before ?? '').split('\n');
    const b = (after ?? '').split('\n');
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    return {
      changed: true,
      addedLines: Math.max(0, b.length - prefix - suffix),
      removedLines: Math.max(0, a.length - prefix - suffix),
    };
  }

  private async branchStates(db: Db, projectId: string, sourceBranchId: string, targetBranchId: string) {
    const rows = await db.$queryRaw<Array<{
      documentId: string; title: string; baseContent: string | null; baseBranchId: string | null;
      sourceRevision: number | null; targetRevision: number | null;
      sourceContent: string | null; targetContent: string | null;
      sourceHeadCommitId: string | null; targetHeadCommitId: string | null;
      sourceWorkspaceVersion: number | null; targetWorkspaceVersion: number | null;
    }>>`
      SELECT d.id AS "documentId", d.title, s.base_content AS "baseContent", s.base_branch_id AS "baseBranchId",
             s.revision AS "sourceRevision", t.revision AS "targetRevision",
             s.content AS "sourceContent", t.content AS "targetContent",
             s.head_commit_id AS "sourceHeadCommitId", t.head_commit_id AS "targetHeadCommitId",
             s.workspace_version AS "sourceWorkspaceVersion", t.workspace_version AS "targetWorkspaceVersion"
      FROM docgrid.workspace_documents d
      LEFT JOIN docgrid.docgrid_branch_documents s ON s.document_id = d.id AND s.branch_id = ${sourceBranchId}::uuid
      LEFT JOIN docgrid.docgrid_branch_documents t ON t.document_id = d.id AND t.branch_id = ${targetBranchId}::uuid
      WHERE d.project_id = ${projectId}::uuid AND d.docgrid_deleted_at IS NULL
      ORDER BY d.title
    `;
    return rows;
  }

  async compare(ownerId: string, sourceBranchId: string, targetBranchId: string) {
    const source = await this.requireBranch(this.prisma, ownerId, sourceBranchId);
    const target = await this.requireBranch(this.prisma, ownerId, targetBranchId);
    if (source.projectId !== target.projectId) throw new BadRequestException('Ветки относятся к разным репозиториям');
    const rows = await this.branchStates(this.prisma, source.projectId, sourceBranchId, targetBranchId);
    // V1 has no artifact-deletion operation. A document absent from the source
    // branch means "not part of this branch", never "replace target with empty".
    const documents = rows
      .filter(r => this.isSourceChange(r))
      .map(r => ({ ...r, ...this.summarize(r.targetContent, r.sourceContent), conflict: r.baseBranchId !== targetBranchId || mergeText(r.baseContent, r.sourceContent ?? "", r.targetContent ?? "").conflict }))
      .filter(r => r.changed);
    return {
      repositoryId: source.projectId,
      source: { id: source.id, name: source.name },
      target: { id: target.id, name: target.name },
      changedDocuments: documents.length,
      addedLines: documents.reduce((n, d) => n + d.addedLines, 0),
      removedLines: documents.reduce((n, d) => n + d.removedLines, 0),
      documents,
    };
  }

  async createReview(ownerId: string, dto: CreateDocGridReviewDto) {
    return this.prisma.$transaction(async tx => {
      await this.requireRepo(tx, ownerId, dto.projectId, 'write');
      await this.ensureMainBranch(tx, ownerId, dto.projectId);
      const source = await this.requireBranch(tx, ownerId, dto.sourceBranchId);
      const target = await this.requireBranch(tx, ownerId, dto.targetBranchId);
      if (source.projectId !== dto.projectId || target.projectId !== dto.projectId) throw new NotFoundException('Вариант не относится к проекту');
      if (source.id === target.id) throw new BadRequestException('Нужны разные варианты');
      const states = await this.branchStates(tx, dto.projectId, source.id, target.id);
      const changed = states.filter(r => this.isSourceChange(r));
      if (!changed.length) throw new BadRequestException('Между вариантами нет изменений');
      const status = changed.some(r => r.baseBranchId !== target.id || mergeText(r.baseContent,r.sourceContent??'',r.targetContent??'').conflict) ? 'CONFLICT' : 'OPEN';
      const sourceSnapshot = Object.fromEntries(changed.map(r => [r.documentId, r.sourceRevision ?? 0]));
      const targetSnapshot = Object.fromEntries(changed.map(r => [r.documentId, r.targetRevision ?? 0]));
      const rows = await tx.$queryRaw<ReviewRow[]>`
        INSERT INTO docgrid.docgrid_reviews(project_id, source_branch_id, target_branch_id, author_id, title, body, status, source_snapshot, target_snapshot)
        VALUES (${dto.projectId}::uuid, ${source.id}::uuid, ${target.id}::uuid, ${ownerId},
                ${dto.title.trim()}, ${dto.body?.trim() || null}, ${status}, ${JSON.stringify(sourceSnapshot)}::jsonb, ${JSON.stringify(targetSnapshot)}::jsonb)
        RETURNING id, project_id AS "projectId", source_branch_id AS "sourceBranchId",
          target_branch_id AS "targetBranchId", author_id AS "authorId", merged_by AS "mergedBy",
          title, body, status, source_snapshot AS "sourceSnapshot", target_snapshot AS "targetSnapshot",
          created_at AS "createdAt", updated_at AS "updatedAt", merged_at AS "mergedAt"
      `;
      await this.event(tx, dto.projectId, ownerId, 'review.opened', 'review', rows[0].id, { source: source.name, target: target.name, documents: changed.length });
      return rows[0];
    });
  }

  private async listReviewsWithDb(db: Db, ownerId: string, projectId: string) {
    await this.requireRepo(db, ownerId, projectId);
    return db.$queryRaw<any[]>`
      SELECT r.id, r.project_id AS "projectId", r.title, r.body, r.status,
             r.source_branch_id AS "sourceBranchId", s.name AS "sourceBranch",
             r.target_branch_id AS "targetBranchId", t.name AS "targetBranch",
             r.author_id AS "authorId", r.merged_by AS "mergedBy",
             r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.merged_at AS "mergedAt"
      FROM docgrid.docgrid_reviews r
      JOIN docgrid.docgrid_branches s ON s.id = r.source_branch_id
      JOIN docgrid.docgrid_branches t ON t.id = r.target_branch_id
      WHERE r.project_id = ${projectId}::uuid
      ORDER BY CASE WHEN r.status IN ('OPEN','CONFLICT') THEN 0 ELSE 1 END, r.created_at DESC
    `;
  }

  listReviews(ownerId: string, projectId: string) {
    return this.listReviewsWithDb(this.prisma, ownerId, projectId);
  }

  async mergeReview(ownerId: string, reviewId: string) {
    const result = await this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<ReviewRow[]>`
        SELECT r.id, r.project_id AS "projectId", r.source_branch_id AS "sourceBranchId",
               r.target_branch_id AS "targetBranchId", r.author_id AS "authorId", r.merged_by AS "mergedBy",
               r.title, r.body, r.status, r.source_snapshot AS "sourceSnapshot",
               r.target_snapshot AS "targetSnapshot", r.created_at AS "createdAt",
               r.updated_at AS "updatedAt", r.merged_at AS "mergedAt"
        FROM docgrid.docgrid_reviews r
        JOIN docgrid.workspace_projects p ON p.id = r.project_id
        WHERE r.id = ${reviewId}::uuid AND (p.owner_id = ${ownerId} OR EXISTS (SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ownerId}))
      `;
      let review = rows[0];
      if (!review) throw new NotFoundException('Согласование не найдено');
      await this.requireRepo(tx,ownerId,review.projectId,'merge');
      const locked = await tx.$queryRaw<Array<{status:string;sourceSnapshot:Record<string,number>;targetSnapshot:Record<string,number>}>>`SELECT status,source_snapshot AS "sourceSnapshot",target_snapshot AS "targetSnapshot" FROM docgrid.docgrid_reviews WHERE id=${reviewId}::uuid FOR UPDATE`;
      review = {...review,...locked[0]};
      if (review.status === 'MERGED') return review;
      if (!['OPEN','CONFLICT'].includes(review.status)) throw new ConflictException('Согласование уже закрыто');
      await this.requireRepo(tx,ownerId,review.projectId,'merge');
      const source = await this.requireBranch(tx, ownerId, review.sourceBranchId);
      const target = await this.requireBranch(tx, ownerId, review.targetBranchId);
      if (target.name === 'main') await this.ensureMainBranch(tx, ownerId, review.projectId);
      const states = await this.branchStates(tx, review.projectId, source.id, target.id);
      const changed = states.filter(r => this.isSourceChange(r));
      const snapshotIds = Object.keys(review.sourceSnapshot).sort();
      const currentIds = changed.map(row => row.documentId).sort();
      const stale = snapshotIds.length !== currentIds.length || snapshotIds.some((id,index)=>id!==currentIds[index]) || changed.some(row =>
        (row.sourceRevision ?? 0) !== Number(review.sourceSnapshot[row.documentId] ?? -1) ||
        (row.targetRevision ?? 0) !== Number(review.targetSnapshot[row.documentId] ?? -1));
      const conflicts = changed.filter(row=>row.baseBranchId!==target.id || mergeText(row.baseContent,row.sourceContent??'',row.targetContent??'').conflict);
      if (stale || conflicts.length) {
        await tx.$executeRaw`UPDATE docgrid.docgrid_reviews SET status='CONFLICT',updated_at=now() WHERE id=${reviewId}::uuid`;
        await this.event(tx,review.projectId,ownerId,'review.conflict','review',reviewId,{stale,documents:conflicts.map(r=>r.documentId)});
        return { conflict:true, code:'CONFLICT', message:stale?'Версии изменились. Проверьте изменения и обновите PR.':'Исправьте конфликтующие документы перед слиянием.', documents:conflicts.map(r=>r.documentId) };
      }

      for (const row of changed) {
        const before = row.targetContent ?? '';
        const after = mergeText(row.baseContent,row.sourceContent ?? '',before).content;
        const nextRevision = (row.targetRevision ?? 0) + 1;
        const message = `Приняты правки: ${review.title}`;
        const hash = this.hashCommit(target.id, row.documentId, nextRevision, message, after);
        const commits = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO docgrid.docgrid_commits(project_id, branch_id, document_id, parent_commit_id, author_id, message, before_content, after_content, content_hash)
          VALUES (${review.projectId}::uuid, ${target.id}::uuid, ${row.documentId}::uuid,
                  ${row.targetHeadCommitId}::uuid, ${ownerId}, ${message}, ${before}, ${after}, ${hash})
          RETURNING id
        `;
        if (row.targetRevision === null) {
          await tx.$executeRaw`
            INSERT INTO docgrid.docgrid_branch_documents(branch_id, document_id, revision, content, head_commit_id, workspace_version)
            VALUES (${target.id}::uuid, ${row.documentId}::uuid, 1, ${after}, ${commits[0].id}::uuid, NULL)
          `;
        } else {
          await tx.$executeRaw`
            UPDATE docgrid.docgrid_branch_documents
            SET content = ${after}, revision = ${nextRevision}, head_commit_id = ${commits[0].id}::uuid, updated_at = CURRENT_TIMESTAMP
            WHERE branch_id = ${target.id}::uuid AND document_id = ${row.documentId}::uuid
          `;
        }
        if (target.name === 'main') {
          const pseudo: BranchDocumentRow = {
            branchId: target.id, documentId: row.documentId, title: row.title, path: '/',
            revision: row.targetRevision ?? 1, content: before, headCommitId: row.targetHeadCommitId,
            workspaceVersion: row.targetWorkspaceVersion, updatedAt: new Date(),
          };
          const workspaceVersion = await this.syncMainWorkspace(tx, ownerId, pseudo, after, message);
          await tx.$executeRaw`
            UPDATE docgrid.docgrid_branch_documents
            SET workspace_version = ${workspaceVersion}
            WHERE branch_id = ${target.id}::uuid AND document_id = ${row.documentId}::uuid
          `;
        }
      }
      for (const row of changed) await tx.$executeRaw`UPDATE docgrid.docgrid_branch_documents SET base_content=${row.sourceContent ?? ''},base_branch_id=${target.id}::uuid WHERE branch_id=${source.id}::uuid AND document_id=${row.documentId}::uuid`;
      await tx.$executeRaw`
        UPDATE docgrid.docgrid_reviews
        SET status = 'MERGED', merged_by = ${ownerId}, merged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${reviewId}::uuid
      `;
      await tx.$executeRaw`UPDATE docgrid.docgrid_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ${target.id}::uuid`;
      await this.event(tx, review.projectId, ownerId, 'review.merged', 'review', review.id, { source: source.name, target: target.name, documents: changed.length });
      return { ...review, status: 'MERGED', mergedBy: ownerId, mergedAt: new Date() };
    });
    if ('conflict' in result) throw new ConflictException(result);
    return result;
  }

  async closeReview(ownerId: string, reviewId: string) {
    return this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ projectId: string; status: string }>>`
        SELECT r.project_id AS "projectId", r.status
        FROM docgrid.docgrid_reviews r JOIN docgrid.workspace_projects p ON p.id = r.project_id
        WHERE r.id = ${reviewId}::uuid AND (p.owner_id = ${ownerId} OR EXISTS (SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ownerId}))
      `;
      if (!rows[0]) throw new NotFoundException('Согласование не найдено');
      await this.requireRepo(tx,ownerId,rows[0].projectId,'write');
      const locked=await tx.$queryRaw<Array<{status:string}>>`SELECT status FROM docgrid.docgrid_reviews WHERE id=${reviewId}::uuid FOR UPDATE`;
      if (!['OPEN','CONFLICT'].includes(locked[0].status)) throw new ConflictException('Согласование уже обработано');
      await tx.$executeRaw`UPDATE docgrid.docgrid_reviews SET status='CLOSED', updated_at=CURRENT_TIMESTAMP WHERE id=${reviewId}::uuid`;
      await this.event(tx, rows[0].projectId, ownerId, 'review.closed', 'review', reviewId);
      return { id: reviewId, status: 'CLOSED' };
    });
  }

  private async listIssuesWithDb(db: Db, ownerId: string, projectId: string) {
    await this.requireRepo(db, ownerId, projectId);
    return db.$queryRaw<any[]>`
      SELECT i.id, i.project_id AS "projectId", i.linked_document_id AS "linkedDocumentId",
             i.author_id AS "authorId", i.kind, i.status, i.title, i.body, i.resolution,
             i.created_at AS "createdAt", i.updated_at AS "updatedAt", i.decided_at AS "decidedAt",
             d.title AS "documentTitle"
      FROM docgrid.docgrid_issues i
      LEFT JOIN docgrid.workspace_documents d ON d.id = i.linked_document_id
      WHERE i.project_id = ${projectId}::uuid
      ORDER BY CASE WHEN i.status='OPEN' THEN 0 ELSE 1 END, i.updated_at DESC
    `;
  }
  listIssues(ownerId: string, projectId: string) { return this.listIssuesWithDb(this.prisma, ownerId, projectId); }

  async createIssue(ownerId: string, projectId: string, dto: CreateDocGridIssueDto) {
    return this.prisma.$transaction(async tx => {
      await this.requireRepo(tx, ownerId, projectId, 'write');
      if (dto.linkedDocumentId) {
        const docs = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM docgrid.workspace_documents WHERE id=${dto.linkedDocumentId}::uuid AND project_id=${projectId}::uuid
        `;
        if (!docs[0]) throw new NotFoundException('Связанный документ не найден');
      }
      const rows = await tx.$queryRaw<any[]>`
        INSERT INTO docgrid.docgrid_issues(project_id, linked_document_id, author_id, kind, title, body)
        VALUES (${projectId}::uuid,
                CASE WHEN ${dto.linkedDocumentId ?? null}::text IS NULL THEN NULL ELSE ${dto.linkedDocumentId ?? null}::uuid END,
                ${ownerId}, ${dto.kind ?? 'ISSUE'}, ${dto.title.trim()}, ${dto.body?.trim() ?? ''})
        RETURNING id, project_id AS "projectId", linked_document_id AS "linkedDocumentId",
                  author_id AS "authorId", kind, status, title, body, resolution,
                  created_at AS "createdAt", updated_at AS "updatedAt", decided_at AS "decidedAt"
      `;
      await this.event(tx, projectId, ownerId, 'issue.created', 'issue', rows[0].id, { kind: rows[0].kind });
      return rows[0];
    });
  }

  async decideIssue(ownerId: string, issueId: string, dto: DecideDocGridIssueDto) {
    return this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ projectId: string; status: string }>>`
        SELECT i.project_id AS "projectId", i.status
        FROM docgrid.docgrid_issues i JOIN docgrid.workspace_projects p ON p.id=i.project_id
        WHERE i.id=${issueId}::uuid AND p.owner_id=${ownerId}
        FOR UPDATE
      `;
      if (!rows[0]) throw new NotFoundException('Задача не найдена');
      await this.requireRepo(tx,ownerId,rows[0].projectId,'write');
      if (rows[0].status !== 'OPEN') throw new ConflictException('Issue уже закрыт');
      await tx.$executeRaw`
        UPDATE docgrid.docgrid_issues
        SET status='DECIDED', kind='DECISION', resolution=${dto.resolution.trim()}, decided_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE id=${issueId}::uuid
      `;
      await this.event(tx, rows[0].projectId, ownerId, 'decision.recorded', 'issue', issueId);
      return { id: issueId, status: 'DECIDED', kind: 'DECISION', resolution: dto.resolution.trim() };
    });
  }

  private async listReleasesWithDb(db: Db, ownerId: string, projectId: string) {
    await this.requireRepo(db, ownerId, projectId);
    return db.$queryRaw<any[]>`
      SELECT r.id, r.project_id AS "projectId", r.branch_id AS "branchId", b.name AS "branch",
             r.created_by AS "createdBy", r.tag, r.title, r.notes, r.created_at AS "createdAt"
      FROM docgrid.docgrid_releases r JOIN docgrid.docgrid_branches b ON b.id=r.branch_id
      WHERE r.project_id=${projectId}::uuid
      ORDER BY r.created_at DESC
    `;
  }
  listReleases(ownerId: string, projectId: string) { return this.listReleasesWithDb(this.prisma, ownerId, projectId); }

  async createRelease(ownerId: string, projectId: string, dto: CreateDocGridReleaseDto) {
    return this.prisma.$transaction(async tx => {
      await this.requireRepo(tx, ownerId, projectId, 'write');
      const branch = await this.requireBranch(tx, ownerId, dto.branchId);
      if (branch.projectId !== projectId) throw new NotFoundException('Вариант не относится к проекту');
      const docs = await tx.$queryRaw<any[]>`
        SELECT d.id, d.title, d.path, bd.revision, bd.content, bd.head_commit_id AS "headCommitId"
        FROM docgrid.docgrid_branch_documents bd
        JOIN docgrid.workspace_documents d ON d.id=bd.document_id
        WHERE bd.branch_id=${branch.id}::uuid
        ORDER BY d.path,d.title
      `;
      const snapshot = { schemaVersion: 1, branch: { id: branch.id, name: branch.name }, documents: docs };
      const rows = await tx.$queryRaw<any[]>`
        INSERT INTO docgrid.docgrid_releases(project_id, branch_id, created_by, tag, title, notes, snapshot)
        VALUES (${projectId}::uuid, ${branch.id}::uuid, ${ownerId}, ${dto.tag.trim()}, ${dto.title.trim()},
                ${dto.notes?.trim() ?? ''}, ${JSON.stringify(snapshot)}::jsonb)
        RETURNING id, project_id AS "projectId", branch_id AS "branchId", created_by AS "createdBy",
                  tag, title, notes, created_at AS "createdAt"
      `.catch((error: unknown) => {
        if (String(error).includes('docgrid_releases_project_tag_key')) throw new ConflictException('Release с таким тегом уже существует');
        throw error;
      });
      await this.event(tx, projectId, ownerId, 'release.created', 'release', rows[0].id, { tag: rows[0].tag, branch: branch.name, documents: docs.length });
      return rows[0];
    });
  }

  private async activityWithDb(db: Db, ownerId: string, projectId: string, limit: number) {
    await this.requireRepo(db, ownerId, projectId);
    const safe = Math.max(1, Math.min(100, limit));
    return db.$queryRaw<any[]>`
      SELECT e.id::text, e.project_id AS "projectId", e.actor_id AS "actorId",
             e.event_type AS "eventType", e.entity_type AS "entityType", e.entity_id AS "entityId",
             e.metadata, e.created_at AS "createdAt"
      FROM docgrid.docgrid_events e
      WHERE e.project_id=${projectId}::uuid
      ORDER BY e.created_at DESC
      LIMIT ${safe}
    `;
  }
  activity(ownerId: string, projectId: string, limit = 50) { return this.activityWithDb(this.prisma, ownerId, projectId, limit); }

  private docGridOrchestraBase(): string {
    const raw = process.env.DOCGRID_ORCHESTRA_URL?.trim() || '';
    if (!raw) throw new ServiceUnavailableException('DOCGRID_ORCHESTRA_URL is not configured');
    let url: URL;
    try { url = new URL(raw); } catch { throw new ServiceUnavailableException('Invalid DOCGRID_ORCHESTRA_URL'); }
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local)) {
      throw new ServiceUnavailableException('DOCGRID_ORCHESTRA_URL must use HTTPS');
    }
    if (url.username || url.password || url.search || url.hash) throw new ServiceUnavailableException('Invalid DOCGRID_ORCHESTRA_URL');
    return url.toString().replace(/\/+$/, '');
  }

  async runAiReview(ownerId: string, projectId: string, dto: RunDocGridAiReviewDto) {
    if (dto.mode && dto.mode !== 'review') throw new BadRequestException('Доступна только проверка ИИ-судьёй');
    const context = await this.prisma.$transaction(async tx => {
      const repository = await this.requireRepo(tx, ownerId, projectId, 'write');
      const main = await this.ensureMainBranch(tx, ownerId, projectId);
      const source = await this.requireBranch(tx, ownerId, dto.sourceBranchId);
      const target = dto.targetBranchId ? await this.requireBranch(tx, ownerId, dto.targetBranchId) : main;
      if (source.projectId !== projectId || target.projectId !== projectId) throw new NotFoundException('Вариант не относится к проекту');
      if (source.id === target.id) throw new BadRequestException('Для проверки нужны разные варианты');
      if (target.name === 'main') await this.ensureMainBranch(tx, ownerId, projectId);
      const states = await this.branchStates(tx, projectId, source.id, target.id);
      const changed = states.filter(row => this.isSourceChange(row));
      if (!changed.length) throw new BadRequestException('Между вариантами нет изменений для проверки');
      if (changed.some(r=>(r.sourceContent?.length||0)>20000||(r.targetContent?.length||0)>20000)) throw new BadRequestException('Проверка: не более 20 000 символов на редакцию документа за запрос');
      if (changed.length > 40) throw new BadRequestException('Проверка ИИ ограничена 40 изменёнными документами за один запрос');
      const issues = await tx.$queryRaw<Array<{ id: string; title: string; status: string; body: string }>>`
        SELECT id, title, status, body
        FROM docgrid.docgrid_issues
        WHERE project_id=${projectId}::uuid AND status='OPEN'
        ORDER BY updated_at DESC
        LIMIT 50
      `;
      const decisions = await tx.$queryRaw<Array<{ id: string; title: string; resolution: string }>>`
        SELECT id, title, COALESCE(resolution, '') AS resolution
        FROM docgrid.docgrid_issues
        WHERE project_id=${projectId}::uuid AND status='DECIDED'
        ORDER BY decided_at DESC
        LIMIT 50
      `;
      const materials=await tx.$queryRaw<Array<{id:string;title:string;sha256:string;text:string;status:string}>>`SELECT id,title,sha256,extracted_text AS text,extraction_status AS status FROM docgrid.docgrid_materials WHERE project_id=${projectId}::uuid AND deleted_at IS NULL ORDER BY id`;
      let remaining=80000;
      const evidence=materials.map(m=>{const text=m.text.slice(0,Math.min(12000,remaining));remaining-=text.length;return {id:m.id,title:m.title,sha256:m.sha256,text,status:text.length<m.text.length?'PARTIAL':m.status};});
      const fingerprint=createHash('sha256').update(JSON.stringify({states,materials:materials.map(m=>({id:m.id,sha256:m.sha256,status:m.status}))})).digest('hex');
      return {
        evidence, fingerprint,
        repository,
        source,
        target,
        issues,
        decisions,
        documents: changed.map(row => ({
          id: row.documentId,
          title: row.title,
          before: row.targetContent ?? '',
          after: row.sourceContent ?? '',
        })),
      };
    });

    const token = process.env.DOCGRID_SERVICE_TOKEN ?? '';
    if (token.length < 32) throw new ServiceUnavailableException('DOCGRID_SERVICE_TOKEN is not configured');
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(this.docGridOrchestraBase() + '/internal/docgrid/review', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(85_000),
        headers: { 'Content-Type': 'application/json', 'x-docgrid-service-token': token },
        body: JSON.stringify({
          mode: 'review',
          repository: { id: context.repository.id, name: context.repository.name },
          sourceBranch: { id: context.source.id, name: context.source.name },
          targetBranch: { id: context.target.id, name: context.target.name },
          instruction: 'Проверь правки как независимый судья. Не изменяй документы.',
          documents: context.documents,
          evidence: context.evidence,
          issues: context.issues.map(i=>({...i,body:i.body.slice(0,4000)})),
          decisions: context.decisions.map(d=>({...d,resolution:d.resolution.slice(0,6000)})),
        }),
      });
    } catch {
      throw new BadGatewayException('AI-Orchestra недоступен');
    }
    const body = await response.text();
    if (body.length > 1_000_000) throw new BadGatewayException('AI-Orchestra response is too large');
    let payload: any;
    try { payload = body ? JSON.parse(body) : {}; } catch { throw new BadGatewayException('AI-Orchestra returned invalid JSON'); }
    if (!response.ok || !payload?.result) {
      throw new BadGatewayException(payload?.message || payload?.error || `AI-Orchestra error ${response.status}`);
    }
    await this.requireRepo(this.prisma,ownerId,projectId,'write');
    payload.coverage=context.evidence.map(({id,title,status})=>({id,title,status}));
    payload.fingerprint=context.fingerprint;
    await this.prisma.$executeRaw`INSERT INTO docgrid.docgrid_judgments(project_id,source_branch_id,target_branch_id,actor_id,fingerprint,result) VALUES(${projectId}::uuid,${context.source.id}::uuid,${context.target.id}::uuid,${ownerId},${context.fingerprint},${JSON.stringify(payload)}::jsonb)`;
    await this.event(this.prisma, projectId, ownerId, 'ai.review.completed', 'branch', context.source.id, {
      mode: 'review',
      sourceBranch: context.source.name,
      targetBranch: context.target.name,
      changedDocuments: context.documents.length,
      model: typeof payload.model === 'string' ? payload.model.slice(0, 200) : null,
      latencyMs: Number.isFinite(payload.latencyMs) ? payload.latencyMs : Date.now() - started,
      risks: Array.isArray(payload.result?.risks) ? payload.result.risks.length : 0,
      suggestions: Array.isArray(payload.result?.suggestedChanges) ? payload.result.suggestedChanges.length : 0,
      usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : {},
    });
    return payload;
  }

  private cleanPath(value?: string) {
    if (value !== undefined && typeof value !== 'string') throw new BadRequestException('Недопустимое имя папки');
    const parts = (value || '/').split('/').filter(Boolean);
    if (parts.some(p=>p==='.'||p==='..'||/[\u0000-\u001f\\]/.test(p)) || parts.length>32 || (value?.length || 0)>500) throw new BadRequestException('Недопустимое имя папки');
    return '/' + parts.join('/');
  }

  async files(ownerId:string,projectId:string,trash=false) {
    await this.requireRepo(this.prisma,ownerId,projectId);
    const materials=await this.prisma.$queryRaw<any[]>`SELECT id,title,path,mime,byte_size AS size,sha256,extraction_status AS "extractionStatus",created_at AS "createdAt",deleted_at AS "deletedAt" FROM docgrid.docgrid_materials WHERE project_id=${projectId}::uuid AND (deleted_at IS NOT NULL)=${trash} ORDER BY path,title`;
    const documents=await this.prisma.$queryRaw<any[]>`SELECT id,title,path,docgrid_deleted_at AS "deletedAt" FROM docgrid.workspace_documents WHERE project_id=${projectId}::uuid AND (docgrid_deleted_at IS NOT NULL)=${trash} ORDER BY path,title`;
    const folders=await this.prisma.$queryRaw<any[]>`SELECT id,path FROM docgrid.docgrid_folders WHERE project_id=${projectId}::uuid ORDER BY path`;
    return {materials,documents,folders};
  }

  private async ensureFolders(tx: Db, projectId: string, path: string) {
    const parts = path.split('/').filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth++) {
      const ancestor = '/' + parts.slice(0, depth).join('/');
      await tx.$executeRaw`INSERT INTO docgrid.docgrid_folders(project_id,path) VALUES(${projectId}::uuid,${ancestor}) ON CONFLICT DO NOTHING`;
    }
  }

  async addFolder(ownerId:string,projectId:string,path:string) {
    const normalized = this.cleanPath(path);
    return this.prisma.$transaction(async tx=>{
      await this.requireRepo(tx,ownerId,projectId,'write');
      await this.ensureFolders(tx,projectId,normalized);
      await this.event(tx,projectId,ownerId,'folder.created','repository',projectId,{path:normalized});
      return {path:normalized};
    });
  }

  async relocateMaterial(ownerId: string, projectId: string, id: string, dto: { sha256: string; fromPath: string; path: string }) {
    const path = this.cleanPath(dto.path), fromPath = this.cleanPath(dto.fromPath);
    if (!/^[0-9a-f]{64}$/.test(dto.sha256)) throw new BadRequestException('Некорректная контрольная сумма');
    return this.prisma.$transaction(async tx => {
      await this.requireRepo(tx,ownerId,projectId,'write');
      const rows = await tx.$queryRaw<any[]>`SELECT id,title,path,sha256,byte_size AS size FROM docgrid.docgrid_materials WHERE id=${id}::uuid AND project_id=${projectId}::uuid AND deleted_at IS NULL FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundException('Материал не найден');
      if (row.sha256 !== dto.sha256) throw new ConflictException('Содержимое файла не совпадает');
      if (row.path === path) return row; // Retry after a lost successful response.
      if (row.path !== fromPath) throw new ConflictException('Папка файла уже изменилась. Обновите список');
      const conflicts = await tx.$queryRaw<any[]>`SELECT id FROM docgrid.docgrid_materials WHERE project_id=${projectId}::uuid AND path=${path} AND title=${row.title} AND id<>${id}::uuid AND deleted_at IS NULL LIMIT 1`;
      if (conflicts.length) throw new ConflictException('В целевой папке уже есть файл с таким именем');
      await this.ensureFolders(tx,projectId,path);
      await tx.$executeRaw`UPDATE docgrid.docgrid_materials SET path=${path} WHERE id=${id}::uuid`;
      await this.event(tx,projectId,ownerId,'material.path.restored','material',id,{fromPath,path,sha256:row.sha256});
      return {...row,path};
    });
  }

  async uploadMaterial(ownerId:string,projectId:string,file:{originalname:string;mimetype:string;buffer:Buffer},path?:string,requestId?:string) {
    if(!file?.buffer?.length)throw new BadRequestException('Файл пуст');
    if(file.buffer.length>DOCGRID_PROJECT_MAX_BYTES)throw new BadRequestException('Файл превышает общий лимит проекта 500 МБ');
    const id = requestId && /^[A-Za-z0-9._:-]{1,100}$/.test(requestId) ? requestId : randomUUID();
    const started = Date.now();
    let stage = 'received';
    const log = (next: string, extra: Record<string, unknown> = {}) => {
      stage = next;
      this.uploadLogger.log(JSON.stringify({ event: 'docgrid.upload', requestId: id, projectId, stage,
        bytes: file.buffer.length, storage: this.materialStorage?.enabled ? 's3' : 'database',
        elapsedMs: Date.now() - started, ...extra }));
    };
    log('received');
    try {
      await this.requireRepo(this.prisma,ownerId,projectId,'write');
      // Multer exposes multipart filenames as Latin-1; browsers submit UTF-8 bytes.
      const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const originalName = /[^\u0000-\u00ff]/.test(file.originalname) || decoded.includes('\uFFFD') ? file.originalname : decoded;
      const normalizedPath = this.cleanPath(path);
      const title=originalName.replace(/[\u0000-\u001f/\\]/g,'_').slice(0,180);
      const hash=createHash('sha256').update(file.buffer).digest('hex');
      const check = async (tx: Db) => {
        await this.requireRepo(tx,ownerId,projectId,'write');
        const existing = await tx.$queryRaw<any[]>`SELECT id,title,path,sha256,extraction_status AS "extractionStatus" FROM docgrid.docgrid_materials WHERE project_id=${projectId}::uuid AND path=${normalizedPath} AND title=${title} AND deleted_at IS NULL ORDER BY created_at,id`;
        if (existing.some(row => row.sha256 !== hash)) throw new ConflictException('В папке уже есть файл с этим именем и другим содержимым');
        if (existing[0]) return {...existing[0], reused: true};
        const total=await tx.$queryRaw<Array<{size:bigint}>>`SELECT COALESCE(sum(byte_size),0)::bigint AS size FROM docgrid.docgrid_materials WHERE project_id=${projectId}::uuid`;
        if(Number(total[0]?.size || 0)+file.buffer.length>DOCGRID_PROJECT_MAX_BYTES)throw new BadRequestException('В проекте доступно 500 МБ, включая корзину');
        return null;
      };
      const reused = await this.prisma.$transaction(check);
      if (reused) { log('reused'); return reused; }
      log('extracting');
      const extraction = await extractMaterialText(title, file.buffer);
      const extracted = extraction.text, status = extraction.status;
      log('extracted', { extractionStatus: status, extractionReason: extraction.reason });
      const mime = file.mimetype.slice(0,150)||'application/octet-stream';
      // Object transfer and read-back verification happen outside database locks.
      // An uncommitted object is retained for reconciliation, never blindly deleted
      // after an ambiguous DB response that may already have committed its pointer.
      log('storing');
      const key = this.materialStorage?.enabled ? await this.materialStorage.store(projectId,file.buffer,hash,mime) : null;
      log('committing');
      const result = await this.prisma.$transaction(async tx=>{
        const duplicate = await check(tx);
        if (duplicate) return duplicate;
        await this.ensureFolders(tx,projectId,normalizedPath);
        const rows=await tx.$queryRaw<any[]>`INSERT INTO docgrid.docgrid_materials(project_id,title,path,mime,bytes,storage_key,byte_size,sha256,extracted_text,extraction_status,created_by) VALUES(${projectId}::uuid,${title},${normalizedPath},${mime},${key ? null : file.buffer}::bytea,${key},${file.buffer.length},${hash},${extracted},${status},${ownerId}) RETURNING id,title,path,sha256,extraction_status AS "extractionStatus"`;
        await this.event(tx,projectId,ownerId,'material.added','material',rows[0].id,{title,path:normalizedPath,sha256:hash,bytes:file.buffer.length,storage:key?'s3':'database'});return rows[0];
      });
      log('completed', { materialId: result.id });
      return result;
    } catch (error) {
      // Never log file content, credentials or raw storage/database errors.
      const failure = error as { name?: string; code?: string; status?: number };
      this.uploadLogger.error(JSON.stringify({ event: 'docgrid.upload.failed', requestId: id, projectId,
        stage, elapsedMs: Date.now() - started, name: failure.name, code: failure.code, status: failure.status }));
      throw error;
    }
  }

  async material(ownerId:string,projectId:string,id:string) {
    await this.requireRepo(this.prisma,ownerId,projectId);
    const rows=await this.prisma.$queryRaw<any[]>`SELECT id,title,mime,bytes,storage_key,byte_size,sha256 FROM docgrid.docgrid_materials WHERE id=${id}::uuid AND project_id=${projectId}::uuid AND deleted_at IS NULL`;
    if(!rows[0])throw new NotFoundException('Материал не найден');
    const row = rows[0];
    return {id:row.id,title:row.title,mime:row.mime,sha256:row.sha256,bytes:await readMaterialBytes(row,this.materialStorage)};
  }

  async trashFile(ownerId:string,projectId:string,id:string,kind:'material'|'document',restore:boolean) {
    return this.prisma.$transaction(async tx=>{
      await this.requireRepo(tx,ownerId,projectId,'write');
      const count=kind==='material'
        ? await tx.$executeRaw`UPDATE docgrid.docgrid_materials SET deleted_at=CASE WHEN ${restore} THEN NULL ELSE now() END WHERE id=${id}::uuid AND project_id=${projectId}::uuid`
        : await tx.$executeRaw`UPDATE docgrid.workspace_documents SET docgrid_deleted_at=CASE WHEN ${restore} THEN NULL ELSE now() END WHERE id=${id}::uuid AND project_id=${projectId}::uuid`;
      if(!count)throw new NotFoundException('Файл не найден');
      await this.event(tx,projectId,ownerId,restore?'file.restored':'file.trashed',kind,id);return {ok:true};
    });
  }

  async restoreCommit(ownerId:string,branchId:string,documentId:string,commitId:string,revision:number) {
    const commit=await this.getCommit(ownerId,commitId);
    if(commit.documentId!==documentId)throw new BadRequestException('Версия другого документа');
    // Authorization and current revision are checked again by saveBranchDocument.
    return this.saveBranchDocument(ownerId,branchId,documentId,{revision,content:commit.afterContent,message:'Восстановлена предыдущая редакция'});
  }

  async refreshReview(ownerId:string,reviewId:string) {
    return this.prisma.$transaction(async tx=>{
      const rows=await tx.$queryRaw<any[]>`SELECT project_id AS "projectId",source_branch_id AS "sourceBranchId",target_branch_id AS "targetBranchId",status FROM docgrid.docgrid_reviews WHERE id=${reviewId}::uuid`;
      const review=rows[0];if(!review)throw new NotFoundException();
      await this.requireRepo(tx,ownerId,review.projectId,'write');
      const locked=await tx.$queryRaw<any[]>`SELECT status FROM docgrid.docgrid_reviews WHERE id=${reviewId}::uuid FOR UPDATE`;
      if(!['OPEN','CONFLICT'].includes(locked[0].status))throw new ConflictException('PR уже обработан');
      const changed=(await this.branchStates(tx,review.projectId,review.sourceBranchId,review.targetBranchId)).filter(r=>this.isSourceChange(r));
      const conflict=changed.some(r=>r.baseBranchId!==review.targetBranchId||mergeText(r.baseContent,r.sourceContent??'',r.targetContent??'').conflict);
      const status=conflict?'CONFLICT':'OPEN';
      await tx.$executeRaw`UPDATE docgrid.docgrid_reviews SET status=${status},source_snapshot=${JSON.stringify(Object.fromEntries(changed.map(r=>[r.documentId,r.sourceRevision??0])))}::jsonb,target_snapshot=${JSON.stringify(Object.fromEntries(changed.map(r=>[r.documentId,r.targetRevision??0])))}::jsonb,updated_at=now() WHERE id=${reviewId}::uuid`;
      await this.event(tx,review.projectId,ownerId,'review.refreshed','review',reviewId,{status});return {id:reviewId,status};
    });
  }

  async members(ownerId:string,projectId:string) {
    await this.requireRepo(this.prisma,ownerId,projectId);
    return this.prisma.$queryRaw<any[]>`SELECT u.email,m.role FROM docgrid.docgrid_members m JOIN docgrid."User" u ON u.id=m.user_id WHERE m.project_id=${projectId}::uuid`;
  }
  async setMember(ownerId:string,projectId:string,email:string,role:string) {
    return this.prisma.$transaction(async tx=>{
      await this.requireRepo(tx,ownerId,projectId,'owner');
      const users=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM docgrid."User" WHERE lower(email)=${email.trim().toLowerCase()} LIMIT 1`;
      if(!users[0])throw new NotFoundException('Пользователь должен сначала войти в DocGrid');
      if(users[0].id===ownerId)throw new BadRequestException('Владелец уже имеет полный доступ');
      if(role==='REMOVE')await tx.$executeRaw`DELETE FROM docgrid.docgrid_members WHERE project_id=${projectId}::uuid AND user_id=${users[0].id}`;
      else await tx.$executeRaw`INSERT INTO docgrid.docgrid_members(project_id,user_id,role) VALUES(${projectId}::uuid,${users[0].id},${role}) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role`;
      await this.event(tx,projectId,ownerId,'access.changed','repository',projectId,{userId:users[0].id,role});return {ok:true};
    });
  }

  async comments(ownerId:string,branchId:string,documentId:string) {
    await this.requireBranch(this.prisma,ownerId,branchId);
    return this.prisma.$queryRaw<any[]>`SELECT c.id,c.body,c.quote,c.revision,c.created_at AS "createdAt",u.email AS author FROM docgrid.docgrid_comments c JOIN docgrid."User" u ON u.id=c.author_id WHERE c.branch_id=${branchId}::uuid AND c.document_id=${documentId}::uuid ORDER BY c.created_at`;
  }
  async addComment(ownerId:string,branchId:string,documentId:string,dto:{body:string;quote?:string;revision:number}) {
    return this.prisma.$transaction(async tx=>{
      const branch=await this.requireBranch(tx,ownerId,branchId);await this.requireRepo(tx,ownerId,branch.projectId,'write');
      const docs=await tx.$queryRaw<Array<{revision:number;content:string}>>`SELECT revision,content FROM docgrid.docgrid_branch_documents WHERE branch_id=${branchId}::uuid AND document_id=${documentId}::uuid`;
      if(!docs[0]||docs[0].revision!==dto.revision)throw new ConflictException('Документ изменился');
      if(dto.quote&&!docs[0].content.includes(dto.quote))throw new BadRequestException('Фрагмент отсутствует в документе');
      const rows=await tx.$queryRaw<any[]>`INSERT INTO docgrid.docgrid_comments(project_id,document_id,branch_id,revision,quote,body,author_id) VALUES(${branch.projectId}::uuid,${documentId}::uuid,${branchId}::uuid,${dto.revision},${dto.quote||''},${dto.body},${ownerId}) RETURNING id`;
      await this.event(tx,branch.projectId,ownerId,'comment.created','document',documentId,{revision:dto.revision});return rows[0];
    });
  }

  async judgments(ownerId:string,projectId:string,branchId:string) {
    await this.requireRepo(this.prisma,ownerId,projectId);
    return this.prisma.$queryRaw<any[]>`SELECT id,result,created_at AS "createdAt",fingerprint FROM docgrid.docgrid_judgments WHERE project_id=${projectId}::uuid AND source_branch_id=${branchId}::uuid ORDER BY created_at DESC LIMIT 10`;
  }

  async adminSummary() {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        (SELECT COUNT(*) FROM docgrid.workspace_projects) AS repositories,
        (SELECT COUNT(*) FROM docgrid.docgrid_branches) AS branches,
        (SELECT COUNT(*) FROM docgrid.docgrid_commits) AS commits,
        (SELECT COUNT(*) FROM docgrid.docgrid_reviews WHERE status='OPEN') AS "openReviews",
        (SELECT COUNT(*) FROM docgrid.docgrid_issues WHERE status='OPEN') AS "openIssues",
        (SELECT COUNT(*) FROM docgrid.docgrid_releases) AS releases,
        (SELECT MAX(created_at) FROM docgrid.docgrid_events) AS "lastActivityAt"
    `;
    const r = rows[0];
    return {
      repositories: Number(r.repositories), branches: Number(r.branches), commits: Number(r.commits),
      openReviews: Number(r.openReviews), openIssues: Number(r.openIssues), releases: Number(r.releases),
      lastActivityAt: r.lastActivityAt,
    };
  }

  async adminEvents(limit = 100) {
    const safe = Math.max(1, Math.min(200, limit));
    return this.prisma.$queryRaw<any[]>`
      SELECT e.id::text, e.project_id AS "projectId", p.name AS "repository",
             e.actor_id AS "actorId", u.email AS "actorEmail",
             e.event_type AS "eventType", e.entity_type AS "entityType", e.entity_id AS "entityId",
             e.metadata, e.created_at AS "createdAt"
      FROM docgrid.docgrid_events e
      JOIN docgrid.workspace_projects p ON p.id=e.project_id
      LEFT JOIN docgrid."User" u ON u.id=e.actor_id
      ORDER BY e.created_at DESC
      LIMIT ${safe}
    `;
  }
}


