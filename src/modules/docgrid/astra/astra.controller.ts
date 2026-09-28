import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { DocGridIdentityGuard } from '../docgrid-identity.guard';
import { AstraAgentGuard } from './astra-agent.guard';
import { AstraService } from './astra.service';

function fileResponse(file: { bytes: Buffer; mime: string; fileName: string }, response: Response) {
  response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  return new StreamableFile(file.bytes, { type: file.mime });
}

@UseGuards(DocGridIdentityGuard)
@Controller(['api/docgrid/repositories/:projectId/agents', 'api/docgrid/repositories/:projectId/astra'])
export class AstraHumanController {
  constructor(private readonly astra: AstraService) {}
  @Get('catalog') catalog(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string) { return this.astra.getCatalog(user, project); }
  @Get('grants') grants(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string) { return this.astra.listGrants(user, project); }
  @Post('grants') createGrant(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Body() input: unknown) { return this.astra.createGrant(user, project, input); }
  @Post('grants/:grantId/revoke') revoke(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Param('grantId', ParseUUIDPipe) id: string, @Body() input: unknown) { return this.astra.revokeGrant(user, project, id, input); }
  @Get('operations') operations(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string) { return this.astra.listOperations(user, project); }
  @Get('operations/:operationId') operation(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Param('operationId', ParseUUIDPipe) id: string) { return this.astra.getOperation(user, project, id); }
  @Post('operations/:operationId/approve') approve(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Param('operationId', ParseUUIDPipe) id: string, @Body() input: unknown) { return this.astra.decideOperation(user, project, id, 'approve', input); }
  @Post('operations/:operationId/cancel') cancel(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Param('operationId', ParseUUIDPipe) id: string, @Body() input: unknown) { return this.astra.decideOperation(user, project, id, 'cancel', input); }
  @Get('artifacts') artifacts(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Query('cursor') cursor?: string) { return this.astra.listArtifacts(user, project, cursor); }
  @Get('artifacts/:artifactId/history') history(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Param('artifactId', ParseUUIDPipe) artifact: string) { return this.astra.humanArtifact(user, project, artifact); }
  @Get('artifacts/:artifactId/versions/:version') artifact(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Param('artifactId', ParseUUIDPipe) artifact: string, @Param('version', ParseIntPipe) version: number) { return this.astra.humanArtifact(user, project, artifact, version); }
  @Get('artifacts/:artifactId/versions/:version/:format') async file(@CurrentUser('id') user: string, @Param('projectId', ParseUUIDPipe) project: string, @Param('artifactId', ParseUUIDPipe) artifact: string, @Param('version', ParseIntPipe) version: number, @Param('format') format: string, @Res({ passthrough: true }) response: Response) { return fileResponse(await this.astra.artifactFile(user, false, project, artifact, version, format), response); }
}

@UseGuards(AstraAgentGuard)
@Controller(['api/docgrid/agents', 'api/docgrid/astra'])
export class AstraAgentController {
  constructor(private readonly astra: AstraService) {}
  @Get('catalog') describe(@Req() request: { astraCredential: string }, @Query('projectId', ParseUUIDPipe) project: string) { return this.astra.describeGrant(request.astraCredential, project); }
  @Post('tools/:toolName') execute(@Req() request: { astraCredential: string }, @Param('toolName') tool: string, @Body() input: unknown) { return this.astra.execute(request.astraCredential, tool, input); }
  @Get('artifacts/:artifactId/versions/:version/:format') async file(@Req() request: { astraCredential: string }, @Query('projectId', ParseUUIDPipe) project: string, @Param('artifactId', ParseUUIDPipe) artifact: string, @Param('version', ParseIntPipe) version: number, @Param('format') format: string, @Res({ passthrough: true }) response: Response) { return fileResponse(await this.astra.artifactFile(request.astraCredential, true, project, artifact, version, format), response); }
  @Get('sources/:sourceId/original') async original(@Req() request: { astraCredential: string }, @Query('projectId', ParseUUIDPipe) project: string, @Query('snapshotId', ParseUUIDPipe) snapshot: string, @Query('hash') hash: string, @Param('sourceId', ParseUUIDPipe) source: string, @Res({ passthrough: true }) response: Response) { return fileResponse(await this.astra.sourceOriginal(request.astraCredential, project, source, snapshot, hash), response); }
}

