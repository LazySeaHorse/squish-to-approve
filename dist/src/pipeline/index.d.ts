export interface PipelineInput {
    msgId: string;
    zipBuffer: Buffer;
    captionText: string;
}
export interface PipelineResult {
    ok: true;
    url: string;
    folderUrl: string;
    docName: string;
}
export interface PipelineError {
    ok: false;
    userMessage: string;
}
export declare function runPipeline(input: PipelineInput): Promise<PipelineResult | PipelineError>;
//# sourceMappingURL=index.d.ts.map