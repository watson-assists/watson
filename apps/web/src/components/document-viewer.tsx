"use client";

// A document opens over the page, in the same window (owner, 23 Nov): a photo as it is, a PDF in the
// browser's own viewer. Escape, Close or a click beside it closes it again.
import { Download, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { documentUrl, type Viewable } from "@/lib/documents";

export function DocumentViewer({ document, onClose, onFailed }: {
  document: Viewable | null;
  onClose: () => void;
  onFailed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const failed = useEffectEvent(onFailed);

  useEffect(() => {
    if (!document) return;
    let current = true;
    let made: string | null = null;
    void documentUrl(document).then((loaded) => {
      if (!current) return loaded && URL.revokeObjectURL(loaded);
      if (!loaded) return failed();
      made = loaded;
      setUrl(loaded);
    });
    return () => {
      current = false;
      setUrl(null);
      if (made) URL.revokeObjectURL(made);
    };
  }, [document]);

  useEffect(() => {
    if (url && !dialog.current?.open) dialog.current?.showModal();
  }, [url]);

  if (!document || !url) return null;
  return (
    <dialog ref={dialog} className="wa-viewer" aria-labelledby="viewer-title" onClose={onClose}
      onClick={(event) => event.target === dialog.current && dialog.current.close()}>
      <div className="wa-viewer__head">
        <h2 className="wa-heading" id="viewer-title">{document.file_name}</h2>
        <div className="wa-actions">
          <a className="wa-button wa-button--secondary wa-button--small" href={url} download={document.file_name}>
            <Download aria-hidden className="wa-icon wa-icon--sm" />Download
          </a>
          <button type="button" className="wa-button wa-button--primary wa-button--small" onClick={() => dialog.current?.close()}>
            <X aria-hidden className="wa-icon wa-icon--sm" />Close
          </button>
        </div>
      </div>
      {document.media_type === "application/pdf"
        ? <iframe className="wa-viewer__page" src={url} title={document.file_name} />
        // eslint-disable-next-line @next/next/no-img-element -- a local blob, which next/image cannot load
        : <img className="wa-viewer__page" src={url} alt={document.file_name} />}
    </dialog>
  );
}
