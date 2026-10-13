import { BadRequestException } from '@nestjs/common';
import { assertKeys, objectInput, stringInput, uuidInput } from './astra/astra.contracts';
import { discussionPath } from './discussion.protocol';

export type WorkflowStep = {
  id: string; title: string; instruction: string; task: 'chat'|'sort'|'package'|'instruction';
  status: 'pending'|'running'|'needs_user_action'|'completed'|'failed'|'cancelled';
  attempt: number; offset: number; nextOffset?: number|null; requestKey?: string;
  turnId?: string; proposalId?: string; result?: string; error?: string;
};
export function workflowEnvironment(r: Record<string, unknown>, allowEmpty = false) {
  let folder: string;
  try { folder = discussionPath(r.folder ?? '/'); } catch { throw new BadRequestException('Некорректная папка'); }
  if (r.sourceIds !== undefined && (!Array.isArray(r.sourceIds) || (!allowEmpty && !r.sourceIds.length) || r.sourceIds.length > 500)) {
    throw new BadRequestException('Выберите от 1 до 500 документов или всё окружение');
  }
  return { folder, ...(r.sourceIds === undefined ? {} : {sourceIds: [...new Set((r.sourceIds as unknown[]).map(id => uuidInput({id}, 'id')))].sort()}) };
}
export function parseWorkflowPlan(answer: string): {title: string; steps: WorkflowStep[]} {
  try {
    const r = objectInput(JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
    assertKeys(r, ['title','steps']);
    const title = stringInput(r, 'title', 180);
    if (!Array.isArray(r.steps) || !r.steps.length || r.steps.length > 8) throw Error('steps');
    const steps = r.steps.map((raw, i) => {
      const s = objectInput(raw); assertKeys(s, ['title','instruction','task']);
      const task = stringInput(s, 'task', 20) as WorkflowStep['task'];
      if (!['chat','sort','package','instruction'].includes(task)) throw Error('tool');
      return {id: String(i+1), title: stringInput(s,'title',160), instruction: stringInput(s,'instruction',280), task, status:'pending' as const, attempt:0, offset:0};
    });
    return {title, steps};
  } catch { throw new BadRequestException('Модель не сформировала корректный пошаговый план. Отмените попытку и уточните задачу.'); }
}
export function planningInstruction(goal: string) {
  return `Составь план задачи. Ничего не выполняй. В поле answer верни только JSON {"title":"название","steps":[{"title":"шаг","instruction":"конкретное поручение","task":"chat"}]}. От 1 до 8 последовательных шагов. title шага до 160 символов, instruction до 280 символов. task: chat — анализ/ответ, sort — предложения размещения документов, package — черновики документов, instruction — юридическая инструкция. Включай изменения только если они нужны по задаче пользователя. Не обещай отправку, web, терминал или иные недоступные инструменты. Учти неполноту источников.\nЗадача: ${goal}`;
}
export function expectsProposal(turn: any) {
  return turn.context?.task !== 'chat' && (turn.result?.package || turn.result?.classifications?.some((c:any) => c.confidence === 'high' && turn.context?.sources?.some((s:any)=>s.sourceId===c.sourceId&&s.path!==c.destination)));
}
