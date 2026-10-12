import { z } from 'zod';

export const toolNames = ['merge','pages','compress','docx-pdf','images-pdf','ocr','number','pdf-docx','redact','compare','pdf-xlsx','watermark','protect','bundle'] as const;
export const sourceSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('material'),id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({kind:z.literal('document'),id:z.string().uuid(),branchId:z.string().uuid(),revision:z.number().int().positive()}).strict(),
]);
const optionsSchema = z.object({
  pages:z.string().max(2000).regex(/^[\d\s,\-]*$/).optional(),
  mode:z.enum(['extract','delete','split']).optional(), rotation:z.union([z.literal(0),z.literal(90),z.literal(180),z.literal(270)]).optional(),
  quality:z.enum(['small','balanced','print']).optional(),landscape:z.boolean().optional(),margin:z.number().int().min(0).max(100).optional(),
  languages:z.enum(['rus+eng','rus','eng']).optional(),start:z.number().int().min(1).max(1000000).optional(),position:z.enum(['top','bottom']).optional(),
  terms:z.string().max(4000).optional(),rects:z.array(z.object({page:z.number().int().min(1).max(300),x:z.number().min(0).max(1),y:z.number().min(0).max(1),w:z.number().positive().max(1),h:z.number().positive().max(1)}).strict().refine(r=>r.x+r.w<=1.001&&r.y+r.h<=1.001)).max(200).optional(),
  text:z.string().trim().min(1).max(100).optional(),opacity:z.number().min(.05).max(.8).optional(),password:z.string().min(8).max(128).optional(),
  format:z.enum(['pdf','zip']).optional(),inventory:z.boolean().optional(),number:z.boolean().optional(),
}).strict();
export const toolInputSchema=z.object({requestId:z.string().uuid(),tool:z.enum(toolNames),title:z.string().trim().min(1).max(100),path:z.string().max(500).default('/Инструменты'),sources:z.array(sourceSchema).min(1).max(30),options:optionsSchema.default({})}).strict().superRefine((v,ctx)=>{
  const multiple=['merge','images-pdf','bundle'];
  if(v.tool==='compare'?v.sources.length!==2:!multiple.includes(v.tool)&&v.sources.length!==1)ctx.addIssue({code:'custom',message:'Недопустимое число исходных файлов'});
  if(v.tool==='merge'&&v.sources.length<2)ctx.addIssue({code:'custom',message:'Выберите минимум два файла'});
  if(v.tool==='protect'&&!v.options.password)ctx.addIssue({code:'custom',message:'Задайте пароль от 8 символов'});
  if(v.tool==='watermark'&&!v.options.text)ctx.addIssue({code:'custom',message:'Введите водяной знак'});
  if(v.tool==='redact'&&!v.options.terms?.trim()&&!v.options.rects?.length)ctx.addIssue({code:'custom',message:'Выделите области или укажите текст для удаления'});
  if(v.tool==='pages'&&v.options.mode==='delete'&&!v.options.pages?.trim())ctx.addIssue({code:'custom',message:'Выберите страницы для удаления'});
});
export type ToolInput=z.infer<typeof toolInputSchema>;
export type ToolSource=z.infer<typeof sourceSchema>;
