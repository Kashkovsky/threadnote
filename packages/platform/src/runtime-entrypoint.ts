import {Context} from 'effect';

export class RuntimeEntrypoint extends Context.Service<
  RuntimeEntrypoint,
  {
    readonly developmentEntrypoint: string;
  }
>()('@threadnote/platform/runtime-entrypoint/RuntimeEntrypoint') {}
