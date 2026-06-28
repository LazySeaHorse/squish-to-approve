export declare function createFolder(parentFolderId: string, folderName: string): Promise<string>;
export declare function copyTemplate(templateId: string, title: string, campaignFolderId: string): Promise<string>;
export declare function uploadImage(filePath: string, campaignFolderId: string): Promise<{
    driveFileId: string;
    publicUrl: string;
}>;
export declare function renameFile(fileId: string, newName: string): Promise<void>;
export declare function deleteFile(fileId: string): Promise<void>;
export declare function shareDoc(docId: string): Promise<void>;
//# sourceMappingURL=drive.d.ts.map