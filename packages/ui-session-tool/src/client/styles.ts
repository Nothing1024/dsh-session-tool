export const styles = `
.st-panel{height:100%;min-height:0;display:flex;flex-direction:column;padding:24px;box-sizing:border-box;color:inherit;font:inherit;overflow:auto}
.st-panel *{box-sizing:border-box}.st-panel header{display:flex;align-items:center;justify-content:space-between;gap:16px}.st-panel h1{font-size:23px;margin:0}.st-panel h2{font-size:18px;margin:0 0 8px}.st-panel p{font-size:13px;opacity:.8}.st-panel button,.st-panel input,.st-panel select,.st-panel textarea{font:inherit;color:inherit;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:7px;background:transparent;padding:8px 10px}.st-panel button{cursor:pointer}.st-panel button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.st-panel button:disabled{opacity:.45;cursor:default}.st-panel :focus-visible{outline:2px solid #6384e8;outline-offset:2px}.st-panel input[type=checkbox]{width:auto}.st-panel select option{background:Canvas;color:CanvasText}.st-filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:16px 0}.st-filters>input{flex:1;min-width:170px}.st-filters label{display:flex;gap:6px;align-items:center;font-size:13px}.st-columns{display:grid;grid-template-columns:minmax(230px,32%) minmax(0,1fr);min-height:0;flex:1;border-top:1px solid color-mix(in srgb,currentColor 15%,transparent)}.st-list{overflow:auto;padding:14px 14px 14px 0;display:flex;flex-direction:column;gap:8px}.st-panel .st-row{text-align:left;display:flex;flex-direction:column;gap:7px;flex-shrink:0}.st-row[aria-pressed=true]{background:color-mix(in srgb,#6384e8 15%,transparent);border-color:#6384e8}.st-row span,.st-row code{font-size:12px;opacity:.8}.st-row strong,.st-panel code{overflow-wrap:anywhere}.st-tags{display:flex;gap:4px;flex-wrap:wrap}.st-tags small{padding:2px 5px;background:color-mix(in srgb,currentColor 9%,transparent);border-radius:4px}.st-detail{min-width:0;overflow:auto;padding:18px;border-left:1px solid color-mix(in srgb,currentColor 15%,transparent)}.st-detail>code{font-size:12px;opacity:.65}.st-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.st-actions button{font-size:12px}.st-note{font-size:12px!important}.st-rename{display:flex;gap:8px;margin:14px 0}.st-rename input{min-width:0;flex:1}.st-panel [role=alert]{color:#d55353;white-space:pre-wrap}.st-message{margin:12px 0;padding:12px;background:color-mix(in srgb,currentColor 4%,transparent);border-radius:8px}.st-message strong{font-size:12px;opacity:.6}.st-message pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;line-height:1.65;margin:8px 0 0}.st-compose{display:flex;align-items:end;gap:10px;margin-top:18px}.st-compose textarea{resize:vertical;min-height:84px;flex:1;min-width:0}.st-empty{display:grid;place-items:center;opacity:.6;min-height:160px}@media(max-width:760px){.st-panel{padding:14px}.st-columns{grid-template-columns:1fr;overflow:auto}.st-list{max-height:35vh;padding-right:0;overflow:auto}.st-detail{overflow:visible;border-left:0;border-top:1px solid color-mix(in srgb,currentColor 15%,transparent);padding:16px 0}.st-compose{align-items:stretch;flex-direction:column}}
`

export const badgeStyles = `
.st-ico{width:14px;height:14px;flex:0 0 auto;display:block}
.st-chips{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.st-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;border:.5px solid transparent;font-size:11px;line-height:18px;font-weight:500;white-space:nowrap;background:transparent;color:color-mix(in srgb,currentColor 55%,transparent)}
.st-chip.has-ico{padding-left:6px}
.st-chip .k{font-size:10px;font-weight:500;opacity:.72}
.st-chip .v{font-weight:650}
.st-chip[data-axis=form][data-app=dsh-bot],.st-chip[data-axis=app][data-app=dsh-bot]{color:#0f766e;background:color-mix(in srgb,#0f766e 12%,transparent)}
.st-chip[data-axis=form][data-app=vibee],.st-chip[data-axis=app][data-app=vibee]{color:#6d28d9;background:color-mix(in srgb,#6d28d9 12%,transparent)}
.st-chip[data-axis=form][data-app=""],.st-chip[data-axis=app][data-app=""]{border-color:color-mix(in srgb,currentColor 20%,transparent)}
.st-chip[data-axis=name]{color:inherit;background:color-mix(in srgb,currentColor 8%,transparent)}
.st-chip[data-axis=child]{color:#b54708;background:color-mix(in srgb,#b54708 12%,transparent)}
.st-chip[data-axis=hidden]{border-style:dashed;border-color:color-mix(in srgb,currentColor 45%,transparent)}
.st-chip[data-axis=free]{color:#245ac2;background:color-mix(in srgb,#245ac2 10%,transparent)}
.st-badge{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:min(360px,36vw)}
.st-badge .st-chips{flex:1;min-width:0;flex-wrap:nowrap;overflow:hidden}
.st-badge-detail{display:inline-flex;align-items:center;gap:4px;flex:none;height:28px;padding:0 9px;border:.5px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:14px;background:transparent;color:inherit;cursor:pointer;font-size:12px;font-weight:650;white-space:nowrap}
.st-badge-detail:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.st-badge-detail.is-on{outline:2px solid #6384e8;outline-offset:1px}
.st-badge-pop{z-index:100;position:absolute;top:calc(100% + 6px);left:0;width:320px;max-width:min(400px,100vw - 32px);max-height:min(420px,100vh - 140px);overflow:auto;padding:8px;border-radius:16px;background:Canvas;color:CanvasText;box-shadow:0 8px 28px rgb(15 17 21 / 18%);display:flex;flex-direction:column;gap:4px}
.st-badge-row{display:grid;grid-template-columns:48px minmax(0,1fr);gap:2px 8px;padding:6px 8px;border-radius:8px}
.st-badge-row .k{font-size:10px;letter-spacing:.06em;opacity:.55;grid-column:1}
.st-badge-row .val{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:650}
.st-badge-row .token{grid-column:2;font-size:10px;opacity:.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.st-badge-row.is-empty .val{font-weight:500;opacity:.55}
.st-badge-unprojected{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 8px;font-size:11px}
.st-badge-unprojected .k{opacity:.55;margin-right:4px}
.st-badge-unprojected code{padding:2px 5px;background:color-mix(in srgb,currentColor 9%,transparent);border-radius:4px}
`
