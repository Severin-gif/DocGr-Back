import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const digest = (value:string) => createHash('sha256').update(value).digest('hex') as string;
export function folderPath(value:unknown='/'):string {
 if(typeof value!=='string'||value.length>500)throw new BadRequestException('Недопустимая папка');
 const parts=value.split('/').filter(Boolean);
 if(parts.length>32||parts.some(p=>p==='.'||p==='..'||/[\u0000-\u001f\\]/.test(p)))throw new BadRequestException('Недопустимая папка');
 return '/'+parts.join('/');
}
export const inFolder=(path:string,scope:string)=>scope==='/'||path===scope||path.startsWith(scope+'/');
export const shareInput=z.object({path:z.string().default('/'),mode:z.enum(['READ','PROPOSE']),expiresAt:z.iso.datetime()}).strict();
const cell=z.object({sheet:z.string().min(1).max(100),row:z.number().int().min(0).max(1999),column:z.number().int().min(0).max(99),value:z.string().max(10000)}).strict();
const base={title:z.string().trim().min(1).max(180),body:z.string().max(4000).default('')};
export const proposalInput=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('MOVE'),fileKind:z.enum(['material','document']),id:z.uuid(),path:z.string(),baseHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 z.object({...base,kind:z.literal('EDIT'),fileKind:z.enum(['material','document']),id:z.uuid(),baseHash:z.string().regex(/^[a-f0-9]{64}$/),content:z.string().max(800000).optional(),cells:z.array(cell).min(1).max(1000).optional()}).strict()
]);
export function parsed<T>(schema:z.ZodType<T>,input:unknown):T{const r=schema.safeParse(input);if(!r.success)throw new BadRequestException('Некорректные параметры');return r.data;}
