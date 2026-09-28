import { ExecutionContext, createParamDecorator } from '@nestjs/common';
export const CurrentUser = createParamDecorator((field: string | undefined, ctx: ExecutionContext) => {
 const user = ctx.switchToHttp().getRequest().user;
 return field ? user?.[field] : user;
});
