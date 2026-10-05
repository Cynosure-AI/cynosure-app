import type { MemoryFileSearchResult, MemoryFileStatus, MemoryFolder } from "../../api/types";

export interface DocumentDragPayload {
  sourceFolderId: string;
  sourceFiles: string[];
}

export type DocumentRow = MemoryFileStatus & { id: string; kind: "file"; name: string };

export type FolderRow = {
  id: string;
  kind: "folder";
  name: string;
  folder: MemoryFolder;
  modifiedAt: number;
  chunkCount?: number;
  status: "folder";
};

export type ExplorerRow = DocumentRow | FolderRow;
export type GlobalDocumentRow = MemoryFileSearchResult & { id: string };

export interface ExplorerContextMenu {
  kind: "folder" | "document";
  folder?: MemoryFolder;
  file?: MemoryFileStatus;
  x: number;
  y: number;
}

export interface UploadResult {
  fileName: string;
  chunks: number;
  error?: string;
}
