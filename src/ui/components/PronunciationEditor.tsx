import { useState } from 'react';
import { useApp } from '../../state/store';
import { Banner, Sheet } from './common';

/**
 * Pronunciation dictionary.
 *
 * Rules rewrite only the text sent to the voice engine; the reader keeps the
 * author's spelling. Because the cache key includes a hash of the spoken text,
 * adding a rule automatically invalidates just the affected chunks.
 */
export function PronunciationEditor({
  onClose,
  docId,
  docTitle,
}: {
  onClose: () => void;
  docId: string | null;
  docTitle: string | null;
}): React.JSX.Element {
  const { rules, addRule, removeRule, reloadOpenDoc } = useApp();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [scope, setScope] = useState<'doc' | 'global'>(docId ? 'doc' : 'global');

  const visible = rules.filter((r) => r.docId === null || r.docId === docId);

  const submit = async () => {
    if (from.trim() === '' || to.trim() === '') return;
    await addRule({
      docId: scope === 'global' ? null : docId,
      from: from.trim(),
      to: to.trim(),
      matchCase: false,
      wholeWord: true,
    });
    setFrom('');
    setTo('');
    await reloadOpenDoc();
  };

  return (
    <Sheet title="Pronunciation" onClose={onClose}>
      <Banner kind="info">
        Spell a word the way it should <em>sound</em>. Narrato only changes what the voice
        says - the text on screen stays exactly as written.
      </Banner>

      <div className="field">
        <label htmlFor="pron-from">Written as</label>
        <input
          id="pron-from"
          className="input"
          value={from}
          placeholder="Kael"
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="pron-to">Pronounced as</label>
        <input
          id="pron-to"
          className="input"
          value={to}
          placeholder="Kay el"
          onChange={(e) => setTo(e.target.value)}
        />
      </div>

      {docId ? (
        <div className="field">
          <label htmlFor="pron-scope">Applies to</label>
          <select
            id="pron-scope"
            className="select"
            value={scope}
            onChange={(e) => setScope(e.target.value as 'doc' | 'global')}
          >
            <option value="doc">Only {docTitle ?? 'this document'}</option>
            <option value="global">Everything I listen to</option>
          </select>
        </div>
      ) : null}

      <button
        className="btn btn-primary btn-block"
        onClick={() => void submit()}
        disabled={from.trim() === '' || to.trim() === ''}
      >
        Save rule
      </button>

      <div className="section">
        <div className="section-head">
          <h2>Saved rules</h2>
        </div>
        {visible.length === 0 ? (
          <p className="small muted">No pronunciation rules yet.</p>
        ) : (
          <div className="stack">
            {visible.map((rule) => (
              <div key={rule.id} className="card" style={{ padding: 10 }}>
                <div className="spread">
                  <div style={{ minWidth: 0 }}>
                    <div className="truncate">
                      <strong>{rule.from}</strong>
                      <span className="muted"> {'→'} </span>
                      {rule.to}
                    </div>
                    <div className="small muted">
                      {rule.docId === null ? 'All documents' : 'This document'}
                    </div>
                  </div>
                  <button
                    className="icon-btn"
                    onClick={() => {
                      void removeRule(rule.id).then(() => reloadOpenDoc());
                    }}
                    aria-label={`Delete rule for ${rule.from}`}
                  >
                    &#128465;
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
