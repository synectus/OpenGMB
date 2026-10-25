"use client";
import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { checkImageFile } from "../../lib/post-images";

export type UploadedImage = { id: string; name: string; url: string; byteSize: number };
export type UploadItem = {
  key: string;
  name: string;
  size: number;
  phase: "uploading" | "done" | "refused";
  percent: number;
  error: string | null;
};

type Body = { ok?: boolean; image?: UploadedImage; error?: { code?: string; message?: string } } | null;

/** multipart POST with progress (fetch cannot report it); resolves "aborted" when stopped. */
function send(form: FormData, onProgress: (p: number) => void) {
  const xhr = new XMLHttpRequest();
  const done = new Promise<{ status: number; body: Body } | "aborted">((resolve, reject) => {
    xhr.open("POST", "/api/post-images");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => resolve("aborted");
    xhr.onload = () => {
      let body: Body = null;
      try {
        body = JSON.parse(xhr.responseText) as Body;
      } catch {
        // a proxy error page, not JSON
      }
      resolve({ status: xhr.status, body });
    };
    xhr.send(form);
  });
  return { xhr, done };
}

/** One queue of library uploads for a workspace. `onUploaded` runs once per stored image. */
export function useImageUpload(workspaceId: string, maxBytes: number, onUploaded: (img: UploadedImage) => void) {
  const t = useTranslations("posts");
  const [items, setItems] = useState<UploadItem[]>([]);
  const seq = useRef(0);
  const running = useRef(new Map<string, XMLHttpRequest>());
  const patch = useCallback(
    (key: string, p: Partial<UploadItem>) => setItems((q) => q.map((i) => (i.key === key ? { ...i, ...p } : i))),
    [],
  );

  const addFiles = useCallback(
    async (list: FileList | File[] | null) => {
      for (const file of Array.from(list ?? [])) {
        const key = `u${seq.current++}`;
        const problem = checkImageFile(t, file, maxBytes);
        setItems((q) => [
          ...q.filter((i) => i.phase === "uploading"),
          { key, name: file.name, size: file.size, phase: problem ? "refused" : "uploading", percent: 0, error: problem },
        ]);
        if (problem) continue;
        const form = new FormData();
        form.set("workspaceId", workspaceId);
        form.set("file", file);
        try {
          const { xhr, done } = send(form, (percent) => patch(key, { percent }));
          running.current.set(key, xhr);
          const r = await done;
          running.current.delete(key);
          if (r === "aborted") {
            setItems((q) => q.filter((i) => i.key !== key));
          } else if (r.status === 201 && r.body?.ok && r.body.image) {
            patch(key, { phase: "done", percent: 100 });
            onUploaded(r.body.image);
          } else {
            const code = r.body?.error?.code ?? `HTTP_${r.status}`;
            patch(key, { phase: "refused", error: `${code}: ${r.body?.error?.message ?? t("img.uploadFailed")}` });
          }
        } catch {
          running.current.delete(key);
          patch(key, { phase: "refused", error: t("img.networkFailed") });
        }
      }
    },
    [workspaceId, maxBytes, onUploaded, patch, t],
  );

  const stop = useCallback((key: string) => running.current.get(key)?.abort(), []);
  const clear = useCallback(() => setItems((q) => q.filter((i) => i.phase === "uploading")), []);
  return { items, addFiles, stop, clear };
}
