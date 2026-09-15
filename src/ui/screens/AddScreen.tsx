import { useRef, useState } from 'react';
import { useApp } from '../../state/store';
import {
  buildDoc,
  importFile,
  importPastedText,
  importPdfWithOcr,
  saveDoc,
} from '../../lib/import';
import type { ImportProgress } from '../../lib/import';
import { detectChapters } from '../../lib/chapters';
import { fetchDirect, fetchViaProxy, normaliseUrl } from '../../lib/import/url';
import { Banner, ProgressBar, Spinner } from '../components/common';

type Mode = 'file' | 'paste' | 'url';

/**
 * Import screen.
 *
 * Every path ends the same way: cleaned text -> chapters -> stored document ->
 * straight into the reader. Errors are shown in plain language with a next
 * step, never as a dead end.
 */
export function AddScreen({
  onImported,
  onBack,
}: {
  onImported: (id: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const { refreshLibrary, showToast } = useApp();
  const [mode, setMode] = useState<Mode>('file');
  const [busy, setBusy] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [pasteText, setPasteText] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [url, setUrl] = useState('');
  /** Set when a direct fetch failed and the proxy is the only option left. */
  const [proxyOffer, setProxyOffer] = useState<string | null>(null);
  /** A scanned PDF awaiting the user's decision to run OCR. */
  const [ocrOffer, setOcrOffer] = useState<File | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);

  const finish = async (doc: Parameters<typeof saveDoc>[0], notes: string[]) => {
    await saveDoc(doc);
    await refreshLibrary();
    setWarnings(notes);
    if (notes.length === 0) onImported(doc.meta.id);
    else {
      // Keep the user here long enough to read the warning, then continue.
      showToast(notes[0]!);
      onImported(doc.meta.id);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0]!;
    setError(null);
    setWarnings([]);
    setOcrOffer(null);
    setBusy({ label: 'Reading file', fraction: null });

    try {
      const result = await importFile(file, setBusy);
      if (result.needsOcr) {
        // Do not silently burn minutes of OCR; ask first.
        setOcrOffer(file);
        setBusy(null);
        return;
      }
      await finish(result, result.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be read.');
    } finally {
      setBusy(null);
    }
  };

  const runOcr = async () => {
    if (!ocrOffer) return;
    setBusy({ label: 'Running OCR', fraction: 0 });
    setError(null);
    try {
      const result = await importPdfWithOcr(ocrOffer, setBusy);
      setOcrOffer(null);
      await finish(result, result.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OCR failed on this PDF.');
    } finally {
      setBusy(null);
    }
  };

  const handlePaste = async () => {
    if (pasteText.trim().length < 10) {
      setError('Paste a bit more text than that.');
      return;
    }
    setError(null);
    setBusy({ label: 'Preparing text', fraction: null });
    try {
      const result = importPastedText(pasteText, pasteTitle.trim());
      await finish(result, []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That text could not be prepared.');
    } finally {
      setBusy(null);
    }
  };

  const loadArticle = async (useProxy: boolean) => {
    setError(null);
    setBusy({ label: 'Fetching article', fraction: null });
    try {
      const target = normaliseUrl(url);
      const article = useProxy ? await fetchViaProxy(target) : await fetchDirect(target);
      const chapters = detectChapters(article.text, article.title);
      const doc = buildDoc({
        title: article.title,
        author: article.siteName,
        source: 'url',
        sourceRef: target,
        chapters,
      });
      setProxyOffer(null);
      await finish(doc, []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'That page could not be read.';
      if (!useProxy) {
        // Almost always CORS. Offer the proxy, but make the trade-off explicit.
        setProxyOffer(message);
        setError(null);
      } else {
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="screen no-player">
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          &#8592;
        </button>
        <h1>Add something to read</h1>
      </div>

      <div className="container">
        <div className="chip-row" style={{ margin: '14px 0 18px' }}>
          {(
            [
              ['file', '\u{1F4C1} File or photo'],
              ['paste', '\u{1F4DD} Paste text'],
              ['url', '\u{1F517} Web page'],
            ] as Array<[Mode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              className={`chip${mode === value ? ' active' : ''}`}
              onClick={() => {
                setMode(value);
                setError(null);
                setProxyOffer(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error ? <Banner kind="error">{error}</Banner> : null}
        {warnings.map((w) => (
          <Banner key={w} kind="warn">
            {w}
          </Banner>
        ))}

        {busy ? (
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
              <Spinner />
              <strong>{busy.label}</strong>
            </div>
            {busy.fraction !== null ? <ProgressBar value={busy.fraction} /> : null}
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              This happens on your device. Nothing is uploaded.
            </p>
          </div>
        ) : null}

        {ocrOffer ? (
          <div className="card" style={{ marginBottom: 14 }}>
            <strong>This PDF appears to contain scanned pages.</strong>
            <p className="small muted" style={{ marginTop: 6 }}>
              There is almost no selectable text in it. Narrato can read the pages as images
              instead. That is slower and works best on clean scans.
            </p>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={() => void runOcr()}>
                Run OCR
              </button>
              <button className="btn" onClick={() => setOcrOffer(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {mode === 'file' ? (
          <div>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.epub,.docx,.txt,.md,.markdown,image/*"
              style={{ display: 'none' }}
              onChange={(e) => void handleFiles(e.target.files)}
            />
            <button
              className="card"
              onClick={() => fileInput.current?.click()}
              style={{
                width: '100%',
                textAlign: 'center',
                padding: '36px 18px',
                borderStyle: 'dashed',
                cursor: 'pointer',
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void handleFiles(e.dataTransfer.files);
              }}
            >
              <div style={{ fontSize: 38, marginBottom: 10 }} aria-hidden="true">
                {'\u{1F4E5}'}
              </div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Choose a file</div>
              <div className="small muted">
                PDF, EPUB, Word (.docx), TXT, Markdown, or a photo / screenshot
              </div>
            </button>

            <p className="small muted" style={{ marginTop: 14 }}>
              Photos of pages, worksheets and screenshots are read with on-device OCR. Only
              upload material you are allowed to read - Narrato does not remove DRM or open
              paywalled content.
            </p>
          </div>
        ) : null}

        {mode === 'paste' ? (
          <div>
            <div className="field">
              <label htmlFor="ptitle">Title (optional)</label>
              <input
                id="ptitle"
                className="input"
                value={pasteTitle}
                placeholder="Chapter notes"
                onChange={(e) => setPasteTitle(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ptext">Text</label>
              <textarea
                id="ptext"
                className="textarea"
                value={pasteText}
                placeholder="Paste anything you want read aloud."
                onChange={(e) => setPasteText(e.target.value)}
              />
            </div>
            <button
              className="btn btn-primary btn-block"
              onClick={() => void handlePaste()}
              disabled={busy !== null}
            >
              Prepare for listening
            </button>
          </div>
        ) : null}

        {mode === 'url' ? (
          <div>
            <div className="field">
              <label htmlFor="url">Web address</label>
              <input
                id="url"
                className="input"
                type="url"
                inputMode="url"
                value={url}
                placeholder="example.com/article"
                onChange={(e) => {
                  setUrl(e.target.value);
                  setProxyOffer(null);
                }}
              />
            </div>

            <button
              className="btn btn-primary btn-block"
              onClick={() => void loadArticle(false)}
              disabled={busy !== null || url.trim() === ''}
            >
              Read this page
            </button>

            {proxyOffer ? (
              <div className="card" style={{ marginTop: 14 }}>
                <strong>Your browser could not fetch that page directly.</strong>
                <p className="small muted" style={{ marginTop: 6 }}>
                  Most sites block direct requests from other pages (CORS). Narrato can retry
                  through a public relay, <span className="mono">api.allorigins.win</span>.
                  That means <strong>the address is sent to a third party</strong>. The page
                  content still stays on your device.
                </p>
                <div className="btn-row">
                  <button className="btn btn-primary" onClick={() => void loadArticle(true)}>
                    Retry via relay
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setMode('paste');
                      setProxyOffer(null);
                    }}
                  >
                    Paste the text instead
                  </button>
                </div>
              </div>
            ) : null}

            <p className="small muted" style={{ marginTop: 14 }}>
              Narrato extracts the article and skips menus, ads and cookie banners. It does not
              bypass paywalls or sign-in walls.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
