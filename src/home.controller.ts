import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DocGridIdentityGuard } from './modules/docgrid/docgrid-identity.guard';
import { DocGridService } from './modules/docgrid/docgrid.service';
import { CurrentUser } from './modules/auth/decorators/current-user.decorator';
import { buildHomeDashboard, parseHomeQuery, HomeRepository, HomeActivity } from './home';
import { BadRequestException } from '@nestjs/common';

@Controller('api/docgrid')
@UseGuards(DocGridIdentityGuard)
export class HomeController {
  constructor(private readonly documents: DocGridService) {}
  @Get('home')
  async home(@CurrentUser('id') owner: string, @Query() params: Record<string, string>) {
    const query = parseHomeQuery(new URLSearchParams(params));
    if (!query) throw new BadRequestException('Некорректные параметры Home');
    const repositories = (await this.documents.listRepositories(owner)).map(row => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
    const groups = await Promise.all(repositories.slice(0, 20).map(async repository => ({
      repository,
      activity: await this.documents.activity(owner, repository.id, query.mode === 'journal' ? 50 : 25) as HomeActivity[],
    })));
    return buildHomeDashboard(repositories, groups, query.mode, query.limit);
  }
}
