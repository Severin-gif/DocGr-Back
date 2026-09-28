export type TaskStatus =
  | 'ANALYZING'
  | 'AWAITING_CONFIRMATION'
  | 'QUEUED'
  | 'GENERATING'
  | 'CONVERTING'
  | 'READY'
  | 'FAILED'
  | 'CANCELLED';

export type DocumentPlan = {
  title: string;
  documentType: string;
  goal: string;
  sections: string[];
  inputsUsed: string[];
  missingData: string[];
  assumptions: string[];
  warnings: string[];
};

export type StructuredLegalDocument = {
  title: string;
  subtitle?: string;
  addressee?: string;
  introduction?: string;
  sections: Array<{ id?: string; heading?: string; paragraphs: string[]; paragraphIds?: string[];
    tables?: Array<{ id?: string; headers?: string[]; rows: string[][] }> }>;
  requests?: string[];
  signatureBlock?: string[];
  warnings?: string[];
};

export type StoredAttachment = {
  name: string;
  mimeType: string;
  size: number;
  objectKey: string;
  extractedText: string;
  checksum: string;
};

export type WorkflowEvent = {
  type: 'task.updated' | 'plan.ready' | 'generation.started' | 'conversion.started' | 'version.ready' | 'task.failed';
  taskId: string;
  status: TaskStatus;
  documentId?: string | null;
  version?: number | null;
  message?: string;
  occurredAt: string;
};


