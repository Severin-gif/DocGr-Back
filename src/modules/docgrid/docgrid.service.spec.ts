import { ExecutionContext, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { DocGridAdminGuard } from './docgrid-admin.guard';
import { DOCGRID_PROJECT_MAX_BYTES, DocGridService } from './docgrid.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('DocGrid core', () => {
  const old = process.env.DOCGRID_ADMIN_TOKEN;
  afterEach(() => {
    if (old === undefined) delete process.env.DOCGRID_ADMIN_TOKEN;
    else process.env.DOCGRID_ADMIN_TOKEN = old;
  });

  it('admin guard fails closed without a strong token', () => {
    delete process.env.DOCGRID_ADMIN_TOKEN;
    const guard = new DocGridAdminGuard();
    expect(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as unknown as ExecutionContext))
      .toThrow(ServiceUnavailableException);
  });

  it('admin guard rejects a wrong token', () => {
    process.env.DOCGRID_ADMIN_TOKEN = 'x'.repeat(40);
    const guard = new DocGridAdminGuard();
    expect(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-docgrid-admin-token': 'y'.repeat(40) } }) }) } as unknown as ExecutionContext))
      .toThrow(UnauthorizedException);
  });

  it('diff summary keeps unchanged documents out and reports one changed segment', () => {
    const service = new DocGridService({} as PrismaService);
    expect((service as any).summarize('a\nb\nc', 'a\nx\nc')).toEqual({ changed: true, addedLines: 1, removedLines: 1 });
    expect((service as any).summarize('same', 'same')).toEqual({ changed: false, addedLines: 0, removedLines: 0 });
  });

  it('does not interpret a document absent from the source branch as deletion', () => {
    const service = new DocGridService({} as PrismaService);
    expect((service as any).isSourceChange({ sourceRevision: null, sourceContent: null, targetContent: 'new in main' })).toBe(false);
    expect((service as any).isSourceChange({ sourceRevision: 1, sourceContent: 'branch', targetContent: 'main' })).toBe(true);
  });

  it('accepts a material larger than the former 10 MB cap while project quota allows it', async () => {
    const tx = {
      $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
        const query = sql.join('?');
        if (query.includes('sum(byte_size)')) return [{size:0n}];
        if (query.includes('INSERT INTO docgrid.docgrid_materials')) return [{id:'material-id',title:'large.bin',path:'/',sha256:'hash',extractionStatus:'UNREAD'}];
        return [];
      }),
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const service = new DocGridService(prisma);
    jest.spyOn(service as any, 'requireRepo').mockResolvedValue({});
    jest.spyOn(service as any, 'event').mockResolvedValue(undefined);

    const file = {
      originalname: 'large.bin',
      mimetype: 'application/octet-stream',
      buffer: Buffer.alloc(11 * 1024 * 1024, 1),
    };
    await expect(service.uploadMaterial('user', 'project', file, '/')).resolves.toEqual(
      expect.objectContaining({ id: 'material-id', title: 'large.bin' }),
    );
    expect(file.buffer.length).toBeLessThan(DOCGRID_PROJECT_MAX_BYTES);
  });

  it('commit hashes are deterministic and content-sensitive', () => {
    const service = new DocGridService({} as PrismaService);
    const a = (service as any).hashCommit('b', 'd', 2, 'message', 'text');
    const b = (service as any).hashCommit('b', 'd', 2, 'message', 'text');
    const c = (service as any).hashCommit('b', 'd', 2, 'message', 'changed');
    expect(a).toHaveLength(64);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

