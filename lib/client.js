/**
 * dsh-skills-panel — browser half.
 *
 * NOT an ES module. A DSH client bundle is a classic script registering one
 * lazy-CJS factory on the page-global facade:
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * `id` must equal the package name. `require` resolves only against the platform
 * module table, this row's `dsh.client.external` suppliers, and other registered
 * bundles — which is why the panel markup is inlined here rather than imported
 * from a sibling module.
 *
 * The host half is reached over the generic Connection RPC channel: every call
 * answers with a `{ok:true,value}` / `{ok:false,error}` envelope.
 *
 * @module dsh-skills-panel/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-skills-panel',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** RPC channel owned by the host half; must match lib/index.js. */
    const CHANNEL = '/skills-panel';

    /** Locale namespace for this panel's dictionary. */
    const NS = 'dsh-skills-panel';

    /** Delay before the once-per-page-load update check, to stay off the first paint. */
    const IDLE_MS = 10000;

    /**
     * Backstop delay for re-checking the whole document for the settings nav row.
     *
     * The row is normally marked synchronously from the very mutation that
     * inserted it (see the observer in `apply`), which is what keeps the shell's
     * gear fallback from being painted at all. This timer only covers the case
     * where the row appears outside the subtree that mutation showed us, so it
     * can afford to be slow.
     */
    const NAV_SWEEP_MS = 400;

    /**
     * Graduation cap for the settings nav row, as a percent-encoded SVG mask.
     *
     * Drawn to fill the 16x16 box to roughly the same extent as the shipped
     * outline icons, and painted with `background-color: currentColor` so it
     * follows the nav row's normal, hover and active colours for free.
     */
    const NAV_ICON_SVG =
      "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'"
      + " stroke='black' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'%3E"
      + "%3Cpath d='M1.2 6.3 8 2.8l6.8 3.5-6.8 3.5z'/%3E"
      + "%3Cpath d='M3.9 8.15v2.85c0 1.3 1.85 2.25 4.1 2.25s4.1-.95 4.1-2.25V8.15'/%3E"
      + "%3Cpath d='M14.8 6.3v3.9'/%3E%3C/svg%3E";

    /** Marker attribute this bundle puts on its own nav row. */
    const NAV_ATTR = 'data-dsh-skills-nav';

    /**
     * Mark a settings nav row when it is this plugin's.
     *
     * The `settings.section` registration contract carries only id, order and
     * label — there is no icon field — and the shell picks the glyph from a
     * hardcoded if-chain over section ids whose fallback is the settings gear,
     * so a third-party section can never be handed its own glyph. The rendered
     * nav button does not name its section either, so the row can only be
     * recognised by its label.
     *
     * Matching is therefore a `<button>` whose first child is an icon and whose
     * text is this panel's title in either spelling. That survives the dialog
     * mounting late, sections being reordered, and a section count we do not
     * control — none of which a positional selector would.
     *
     * React owns this subtree, but only rewrites the attributes it renders, so a
     * marker we add stays put until the node is replaced.
     *
     * @param button - candidate element.
     * @returns the button when this call marked it, otherwise null.
     */
    function markNavButton(button) {
      if (button.hasAttribute(NAV_ATTR)) return null;
      const first = button.firstElementChild;
      if (first === null || first === undefined) return null;
      if (String(first.tagName).toLowerCase() !== 'svg') return null;
      // Both spellings, so the mark survives a locale change. Read here
      // rather than at module scope: the dictionaries are declared below.
      const label = String(button.textContent || '').trim();
      if (label !== EN.title && label !== ZH.title) return null;
      button.setAttribute(NAV_ATTR, '');
      return button;
    }

    /**
     * Nearest enclosing `<button>`, for a label written into a mounted row.
     * @param node - the node that was inserted.
     * @returns the owning button, or null.
     */
    function enclosingButton(node) {
      let parent = node.parentNode;
      while (parent !== null && parent !== undefined && parent.nodeType === 1) {
        if (String(parent.tagName).toLowerCase() === 'button') return parent;
        parent = parent.parentNode;
      }
      return null;
    }

    /**
     * Mark this plugin's nav row anywhere inside `root`.
     *
     * Scoped to a subtree so the mutation observer can inspect only what React
     * just inserted rather than walking the whole document — that is what keeps
     * the observer cheap enough to run synchronously, before the paint that
     * would otherwise show the shell's gear fallback.
     *
     * Every match is marked, not just the first: the shell renders one row, but
     * marking all of them costs nothing and covers a locale change that briefly
     * leaves both spellings mounted.
     *
     * @param root - a Document or Element to search.
     * @returns the first button marked by this call, otherwise null.
     */
    function markNavRowIn(root) {
      let first = null;
      if (root.nodeType === 1 && String(root.tagName).toLowerCase() === 'button') {
        first = markNavButton(root);
      }
      if (typeof root.querySelectorAll !== 'function') return first;
      for (const button of root.querySelectorAll('button')) {
        const hit = markNavButton(button);
        if (hit !== null && first === null) first = hit;
      }
      return first;
    }

    const CSS = [
      '.dshsk-wrap{display:flex;flex-direction:column;gap:0;padding:0 0 16px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dshsk-head{position:sticky;top:0;z-index:6;display:flex;flex-direction:column;gap:12px;padding:1px 0 8px;background:var(--dsw-alias-bg-layer-2)}',
      '.dshsk-body{display:flex;flex-direction:column;min-height:0}',
      '.dshsk-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}',
      '.dshsk-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dshsk-tabs{display:flex;align-items:flex-end;gap:22px;margin-top:2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshsk-tab{position:relative;background:0 0;border:0;padding:7px 1px 9px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dshsk-tab:hover{color:var(--dsw-alias-label-secondary)}',
      '.dshsk-tab:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3);border-radius:6px}',
      '.dshsk-tab-on{color:var(--dsw-alias-label-primary)}',
      '.dshsk-tab-on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px;background:var(--dsw-alias-label-primary)}',
      '.dshsk-in{box-sizing:border-box;flex:1 1 auto;min-width:170px;height:32px;padding:0 10px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;transition:border-color .16s,background .16s}',
      '.dshsk-in:focus-visible{outline:none;border-color:var(--dsw-alias-border-l2);box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dshsk-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:0 0;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;cursor:pointer;transition:border-color .16s,background .16s}',
      '.dshsk-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshsk-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dshsk-btn:disabled{opacity:.4;cursor:default}',
      '.dshsk-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
      '.dshsk-danger{color:var(--dsw-alias-state-error-primary);background:0 0;border-color:transparent}',
      '.dshsk-danger:hover:enabled{background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dshsk-seg{display:inline-flex;align-items:center;gap:2px;height:36px;padding:2px;background:var(--dsw-alias-bg-module-platform);border:none;border-radius:18px}',
      '.dshsk-segbtn{display:inline-flex;align-items:center;gap:4px;height:32px;padding:0 12px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:16px;cursor:pointer;white-space:nowrap;transition:background .16s,color .16s}',
      '.dshsk-segbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshsk-segbtn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dshsk-segon,.dshsk-segon:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}',
      '.dshsk-segtick{font-size:10px}',
      '.dshsk-dd{position:relative;display:inline-flex;max-width:100%}',
      '.dshsk-ddtoggle{display:inline-flex;align-items:center;gap:12px;max-width:100%;height:36px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:none;border-radius:18px;cursor:pointer;white-space:nowrap;transition:background .16s}',
      '.dshsk-ddtoggle:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshsk-ddtoggle:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dshsk-ddlabel{overflow:hidden;text-overflow:ellipsis;max-width:240px}',
      '.dshsk-ddcaret{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.dshsk-ddmenu{position:absolute;top:calc(100% + 6px);left:0;z-index:30;display:flex;flex-direction:column;gap:2px;min-width:240px;max-width:340px;max-height:280px;overflow:auto;padding:6px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.22))}',
      '.dshsk-dditem{display:flex;flex-direction:column;gap:2px;text-align:left;padding:6px 10px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:10px;cursor:pointer}',
      '.dshsk-dditem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshsk-dditem:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dshsk-dditem-on{background:var(--dsw-specific-sidebar-nav-item-active,var(--dsw-alias-bg-layer-3))}',
      '.dshsk-ddsub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.dshsk-status{min-height:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.dshsk-status-err{color:var(--dsw-alias-state-error-primary)}',
      '.dshsk-row{display:flex;flex-direction:column;gap:8px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshsk-row:last-child{border-bottom:none}',
      '.dshsk-rowmain{display:flex;align-items:flex-start;gap:12px}',
      '.dshsk-rowtext{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}',
      '.dshsk-ctl{display:flex;align-items:center;gap:8px;flex:none}',
      '.dshsk-ctllabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dshsk-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border-radius:999px;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);cursor:pointer;transition:background .16s,border-color .16s}',
      '.dshsk-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .16s,background .16s}',
      '.dshsk-switch-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dshsk-switch-on .dshsk-knob{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.dshsk-switch:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dshsk-detail{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshsk-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dshsk-name{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dshsk-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.dshsk-tag{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;padding:1px 6px;font-size:11px;line-height:16px;white-space:nowrap}',
      '.dshsk-new{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.dshsk-warn{color:var(--dsw-alias-state-warn-label)}',
      '.dshsk-err{color:var(--dsw-alias-state-error-primary)}',
      '.dshsk-pre{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;max-height:300px;overflow:auto;padding:10px 12px;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0}',
      '.dshsk-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all}',
      '.dshsk-sec{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dshsk-list{display:flex;flex-direction:column;max-height:max(220px, calc(100vh - 400px));overflow:auto;padding-right:2px}',
      '.dshsk-dest{display:flex;flex-direction:column;gap:2px;padding:8px 12px;background:var(--dsw-alias-bg-module-platform);border-radius:12px}',
      '.dshsk-destlabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshsk-destpath{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.dshsk-list::-webkit-scrollbar,.dshsk-pre::-webkit-scrollbar,.dshsk-ddmenu::-webkit-scrollbar{width:8px;height:8px}',
      '.dshsk-list::-webkit-scrollbar-thumb,.dshsk-pre::-webkit-scrollbar-thumb,.dshsk-ddmenu::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}',
      '.dshsk-list::-webkit-scrollbar-thumb:hover,.dshsk-pre::-webkit-scrollbar-thumb:hover,.dshsk-ddmenu::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}',
      '.dshsk-list::-webkit-scrollbar-track,.dshsk-pre::-webkit-scrollbar-track,.dshsk-ddmenu::-webkit-scrollbar-track{background:transparent}',
      // Settings nav glyph, applied to the row this bundle marked above.
      'button[' + NAV_ATTR + '] > svg{display:none}',
      'button[' + NAV_ATTR + ']::before{content:"";flex:none;width:16px;height:16px;background-color:currentColor;'
        + '-webkit-mask:url("data:image/svg+xml;utf8,' + NAV_ICON_SVG + '") center/contain no-repeat;'
        + 'mask:url("data:image/svg+xml;utf8,' + NAV_ICON_SVG + '") center/contain no-repeat}',
    ].join('');

    const EN = {
      title: 'Skills', global: 'All user skills (global)', project: 'Project', refresh: 'Refresh',
      tabInstalled: 'Installed', tabFind: 'Find & install', tabImport: 'Import',
      search: 'Search skills.sh', searching: 'Searching...',
      installTo: 'Install to', toGlobal: 'Global', toProject: 'Project', dest: 'Destination',
      view: 'View', hide: 'Hide', noSkills: 'No skills found in this scope.',
      loading: 'Loading...', installs: 'installs', skipped: 'skipped', preview: 'Details', confirm: 'Install',
      cancel: 'Cancel', low: 'low installs', shadows: 'overrides',
      noMatch: 'No matches.', installing: 'Installing...', installed: 'Installed skills',
      filter: 'Filter installed skills by name or description', none: 'Nothing matches the filter.',
      modeAuto: 'Auto', modeManual: 'Manual',
      ctxOn: 'Injected into the model context automatically', ctxOff: 'Not invoked automatically; use /name',
      shared: 'shared link', notOwned: 'not DSH-owned',
      shortLink: 'link', shortNotOwned: 'not owned', shortNoDir: 'no directory',
      uninstall: 'Remove', confirmDel: 'Confirm remove', delHintLink: 'Removes only the link; the source folder stays.',
      delHint: 'Deletes the skill folder from disk.',
      pickProject: 'Choose a project first', chooseProject: 'Select a project...', descLoading: 'loading description...',
      checkUpdates: 'Check all for updates', checking: 'Checking...', update: 'Update', updating: 'Updating...',
      hasUpdate: 'update available', upToDate: 'up to date', imported: 'imported', managed: 'installed here',
      noRecord: 'no source record', alreadyTag: 'already installed', reinstall: 'Reinstall',
      noChange: 'Already up to date; nothing was changed.',
      checkingRemote: 'Checking the repository first...',
      checked: 'checked', skillsWord: 'skills', withUpdates: 'with updates',
      autoHint: 'All installed skills are checked once in the background after the page loads.',
      importTitle: 'Import a local skill folder',
      srcPath: 'Skill folder or SKILL.md path', pickDir: 'Browse...',
      importMode: 'Import as', modeLink: 'Link', modeCopy: 'Copy',
      doImport: 'Import', importing: 'Importing...',
      linkHint: 'Link creates a junction: the original folder stays the source of truth.',
      copyHint: 'Copy duplicates the files into the skills root.',
      importNoUpdate: 'Imported skills are not checked for updates.',
      viaNote: 'Both the description and the install come from the repository archive, so no GitHub API token or hourly quota is involved.',
      skillDoc: 'SKILL.md',
      noPicker: 'No directory picker is available in this build.',
    };
    const ZH = {
      title: '技能', global: '全部用户技能（全局）', project: '项目', refresh: '刷新',
      tabInstalled: '已安装', tabFind: '搜索安装', tabImport: '导入',
      search: '搜索 skills.sh', searching: '搜索中…',
      installTo: '安装到', toGlobal: '全局', toProject: '项目', dest: '安装位置',
      view: '查看', hide: '收起', noSkills: '该范围内没有技能。',
      loading: '加载中…', installs: '安装量', skipped: '已跳过', preview: '详情', confirm: '安装',
      cancel: '取消', low: '安装量偏低', shadows: '覆盖',
      noMatch: '没有匹配结果。', installing: '安装中…', installed: '已安装技能',
      filter: '按名称或描述筛选已安装技能', none: '没有符合筛选的技能。',
      modeAuto: '自动', modeManual: '手动',
      ctxOn: '自动注入到模型 context', ctxOff: '不自动调用，需用 /名称',
      shared: '共享链接', notOwned: '非 DSH 所有',
      shortLink: '链接', shortNotOwned: '非自有', shortNoDir: '无目录',
      uninstall: '移除', confirmDel: '确认移除', delHintLink: '仅删除链接，源目录不会被删除。',
      delHint: '将从磁盘删除该技能目录。',
      pickProject: '请先选择项目', chooseProject: '选择项目…', descLoading: '正在加载描述…',
      checkUpdates: '检查全部更新', checking: '检查中…', update: '更新', updating: '更新中…',
      hasUpdate: '有可用更新', upToDate: '已是最新', imported: '已导入', managed: '本面板安装',
      noRecord: '无来源记录', alreadyTag: '已安装', reinstall: '重新安装',
      noChange: '已是最新，未做任何改动。',
      checkingRemote: '正在先行检查仓库…',
      checked: '已检查', skillsWord: '个技能', withUpdates: '个有更新',
      autoHint: '每次打开页面后会在后台检查一次全部已安装技能。',
      importTitle: '导入本地技能目录',
      srcPath: '技能目录或 SKILL.md 路径', pickDir: '浏览…',
      importMode: '导入方式', modeLink: '链接', modeCopy: '复制',
      doImport: '导入', importing: '导入中…',
      linkHint: '链接会创建 junction，原目录仍是唯一来源。',
      copyHint: '复制会把文件拷贝到技能目录。',
      importNoUpdate: '导入的技能不参与更新检查。',
      viaNote: '描述和安装都直接来自仓库压缩包，不需要 GitHub API token，也不占用每小时配额。',
      skillDoc: '技能文档 SKILL.md',
      noPicker: '当前构建中没有可用的目录选择器。',
    };

    /** Last path segment, tolerating either separator. */
    const baseName = (p) => {
      const s = String(p).replace(/[\\/]+$/, '');
      const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(String.fromCharCode(92)));
      return i >= 0 ? s.slice(i + 1) : s;
    };

    function Segmented(props) {
      return h('div', { className: 'dshsk-seg' }, props.options.map(function (o) {
        const on = o.value === props.value;
        return h('button', {
          key: o.value, type: 'button', title: o.title || o.label,
          'aria-pressed': on ? 'true' : 'false',
          className: on ? 'dshsk-segbtn dshsk-segon' : 'dshsk-segbtn',
          onClick: function () { if (!on) props.onChange(o.value); },
        }, on ? h('span', { className: 'dshsk-segtick' }, '\u2713') : null, h('span', null, o.label));
      }));
    }

    function Switch(props) {
      return h('button', {
        type: 'button', role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label, title: props.label,
        className: props.checked ? 'dshsk-switch dshsk-switch-on' : 'dshsk-switch',
        onClick: function () { props.onChange(!props.checked); },
      }, h('span', { className: 'dshsk-knob' }));
    }

    function Dropdown(props) {
      const [open, setOpen] = React.useState(false);
      let current = null;
      for (const o of props.options) { if (o.value === props.value) { current = o; break; } }
      const label = current === null ? String(props.value) : current.label;
      return h('div', {
        className: 'dshsk-dd', tabIndex: -1,
        onBlur: function (e) {
          const rt = e.relatedTarget;
          if (rt === null || rt === undefined || !e.currentTarget.contains(rt)) setOpen(false);
        },
        onKeyDown: function (e) { if (e.key === 'Escape') setOpen(false); },
      },
        h('button', {
          type: 'button', className: 'dshsk-ddtoggle',
          'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false',
          title: current !== null && current.title ? current.title : label,
          onClick: function () { setOpen(!open); },
        },
          h('span', { className: 'dshsk-ddlabel' }, label),
          h('span', { className: 'dshsk-ddcaret' }, open ? '\u25B2' : '\u25BC')),
        open ? h('div', { className: 'dshsk-ddmenu', role: 'listbox' },
          props.options.map(function (o) {
            const on = o.value === props.value;
            return h('button', {
              key: o.value === '' ? '__none' : o.value,
              type: 'button', role: 'option', 'aria-selected': on ? 'true' : 'false',
              className: on ? 'dshsk-dditem dshsk-dditem-on' : 'dshsk-dditem',
              onClick: function () { setOpen(false); if (!on) props.onChange(o.value); },
            },
              h('span', null, o.label),
              (o.title && o.title !== o.label) ? h('span', { className: 'dshsk-ddsub' }, o.title) : null);
          })) : null,
      );
    }

    /**
     * Build the panel component for one owning context.
     * @param ctx - Client Cordis context.
     * @param deps.translate - `(key) => string`.
     * @param deps.store - shared update store, `{ get, subscribe, publish }`.
     * @param deps.subscribeLocale - `(fn) => unsubscribe`.
     * @returns the component registered into `settings.section`.
     */
    function createPanel(ctx, deps) {
      const store = deps.store;
      const subscribeLocale = deps.subscribeLocale;

      /** The folder picker, when this build ships one. */
      const pickDirectory = () => {
        const uw = ctx.uiWorkspace;
        if (uw === undefined || uw === null || typeof uw.pickDirectory !== 'function') {
          return Promise.reject(new Error('no picker'));
        }
        return Promise.resolve(uw.pickDirectory());
      };

      let inflightToggle = '';

      function Panel() {
        const [boot, setBoot] = React.useState(null);
        const [view, setView] = React.useState('installed');
        const [pp, setPp] = React.useState('');
        const [skills, setSkills] = React.useState(null);
        const [inst, setInst] = React.useState({});
        const [updateMap, setUpdateMap] = React.useState(store.get());
        const [err, setErr] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [openName, setOpenName] = React.useState('');
        const [body, setBody] = React.useState(null);
        const [q, setQ] = React.useState('');
        const [res, setRes] = React.useState(null);
        const [descs, setDescs] = React.useState({});
        const [detailKey, setDetailKey] = React.useState('');
        const [detail, setDetail] = React.useState(null);
        const [serr, setSerr] = React.useState('');
        const [target, setTarget] = React.useState('global');
        const [note, setNote] = React.useState(null);
        const [searching, setSearching] = React.useState(false);
        const [installing, setInstalling] = React.useState(false);
        const [filter, setFilter] = React.useState('');
        const [, setTick] = React.useState(0);
        const [confirmDel, setConfirmDel] = React.useState('');
        const [deleting, setDeleting] = React.useState('');
        const [checking, setChecking] = React.useState(false);
        const [updatingName, setUpdatingName] = React.useState('');
        const [srcPath, setSrcPath] = React.useState('');
        const [impMode, setImpMode] = React.useState('link');
        const [importing, setImporting] = React.useState(false);

        React.useEffect(function () {
          setUpdateMap(store.get());
          return store.subscribe(setUpdateMap);
        }, []);
        React.useEffect(function () {
          if (typeof subscribeLocale !== 'function') return undefined;
          let off;
          try {
            off = subscribeLocale(function () { setTick(function (n) { return n + 1; }); });
          } catch (e) { return undefined; }
          return function () { try { if (typeof off === 'function') off(); } catch (e) {} };
        }, []);

        const tt = (k) => deps.translate(k);
        const updates = updateMap[pp] || {};
        const say = (text) => setNote({ v: view, text: String(text) });
        const clearNote = () => setNote(null);
        const mark = (key, value) => {
          const next = Object.assign({}, updates);
          if (value === null) delete next[key]; else next[key] = value;
          store.publish(pp, next);
        };

        const load = (projectPath) => {
          setBusy(true); setErr('');
          hostCall('list', { projectPath: projectPath || '' }).then(function (r) {
            if (r && r.ok) {
              setSkills(r.skills);
              setInst(r.installed || {});
              setBoot(function (b) { return b ? Object.assign({}, b, { globalRoot: r.globalRoot }) : b; });
            } else { setSkills([]); setErr((r && r.error) || 'Could not list skills.'); }
            setBusy(false);
          }).catch(function (e) { setErr(String(e && e.message ? e.message : e)); setBusy(false); });
        };

        React.useEffect(function () {
          let alive = true;
          hostCall('bootstrap', {}).then(function (r) {
            if (!alive) return;
            setBoot(r || {});
            setBusy(true);
            hostCall('list', { projectPath: '' }).then(function (lr) {
              if (!alive) return;
              if (lr && lr.ok) { setSkills(lr.skills); setInst(lr.installed || {}); }
              else { setSkills([]); setErr((lr && lr.error) || 'Could not list skills.'); }
              setBusy(false);
            }).catch(function (e) { if (alive) { setErr(String(e && e.message ? e.message : e)); setBusy(false); } });
          }).catch(function (e) { if (alive) { setErr(String(e && e.message ? e.message : e)); setBusy(false); } });
          return function () { alive = false; };
        }, []);

        const onProject = (v) => {
          setPp(v); setOpenName(''); setBody(null); clearNote(); setFilter('');
          setConfirmDel(''); load(v);
        };
        const onToggleBody = (name) => {
          if (openName === name) { setOpenName(''); setBody(null); return; }
          setOpenName(name); setBody(null);
          hostCall('body', { name: name, projectPath: pp }).then(function (r) {
            if (r && r.ok) setBody(r);
            else setBody({ ok: false, error: (r && r.error) || 'Could not read the skill.' });
          }).catch(function (e) { setBody({ ok: false, error: String(e && e.message ? e.message : e) }); });
        };
        const setOne = (name, value) => {
          setSkills(function (cur) {
            if (!Array.isArray(cur)) return cur;
            return cur.map(function (x) {
              return x.name === name ? Object.assign({}, x, { modelInvocable: value }) : x;
            });
          });
        };
        const onSetEnabled = (s, next) => {
          if (inflightToggle === s.name) return;
          inflightToggle = s.name;
          setOne(s.name, next);
          hostCall('set-enabled', { name: s.name, projectPath: pp, enabled: next }).then(function (r) {
            inflightToggle = '';
            if (r && r.ok) { clearNote(); return; }
            setOne(s.name, !next); say('FAILED: ' + ((r && r.error) || 'unknown error'));
          }).catch(function (e) {
            inflightToggle = ''; setOne(s.name, !next);
            say('FAILED: ' + String(e && e.message ? e.message : e));
          });
        };
        const onUninstall = (s) => {
          if (confirmDel !== s.name) { setConfirmDel(s.name); clearNote(); return; }
          setConfirmDel(''); setDeleting(s.name); clearNote();
          hostCall('uninstall', { name: s.name, projectPath: pp }).then(function (r) {
            setDeleting('');
            if (r && r.ok) {
              mark(s.name, null);
              say('REMOVED ' + r.name + (r.linked ? ' (link only)' : ''));
              setOpenName(''); setBody(null); load(pp);
            } else {
              say('FAILED: ' + ((r && r.error) || 'unknown error') + (r && r.detail ? ' | ' + r.detail : ''));
            }
          }).catch(function (e) { setDeleting(''); say('FAILED: ' + String(e && e.message ? e.message : e)); });
        };
        const onCheck = () => {
          setChecking(true); clearNote();
          hostCall('check-updates', { projectPath: pp }).then(function (r) {
            setChecking(false);
            if (r && r.ok) {
              const u = r.updates || {};
              store.publish(pp, u);
              let total = 0;
              for (const x of all) if (x.mode === 'install') total += 1;
              let n = 0;
              for (const k in u) { if (u[k] !== undefined && u[k] !== null && u[k].status === 'update') n += 1; }
              say(tt('checked') + ' ' + total + ' ' + tt('skillsWord') + '  \u00B7  ' + n + ' ' + tt('withUpdates'));
            } else { say('FAILED: ' + ((r && r.error) || 'update check failed')); }
          }).catch(function (e) { setChecking(false); say('FAILED: ' + String(e && e.message ? e.message : e)); });
        };
        const onUpdate = (s) => {
          setUpdatingName(s.name); say(tt('checkingRemote'));
          hostCall('update', { name: s.name, projectPath: pp }).then(function (r) {
            setUpdatingName('');
            if (r && r.ok) {
              if (r.upToDate) {
                mark(s.name, { status: 'current' });
                say(tt('noChange') + '  [' + s.name + ']');
                return;
              }
              mark(s.name, null);
              say('UPDATED ' + r.name + ' (' + r.written.length + ' entries, ' + String(r.via) + ')');
              load(pp);
            } else { say('FAILED: ' + ((r && r.error) || 'update failed')); }
          }).catch(function (e) { setUpdatingName(''); say('FAILED: ' + String(e && e.message ? e.message : e)); });
        };
        const onSearch = () => {
          setSearching(true); setSerr(''); setRes(null); setDescs({});
          setDetailKey(''); setDetail(null); clearNote();
          hostCall('search', { query: q }).then(function (r) {
            if (!r || !r.ok) { setSerr((r && r.error) || 'Search failed.'); setSearching(false); return; }
            const items = r.results;
            setRes(items); setSearching(false);
            const top = items.slice(0, 6);
            if (top.length === 0) return;
            // One request per card, merged as each lands. A repository that is
            // slow or unreachable then leaves its own line blank instead of
            // holding back every other result in the list.
            for (const x of top) {
              hostCall('describe', { items: [{ source: x.source, skillId: x.skillId }] })
                .then(function (d) {
                  if (!d || !d.ok || !d.descriptions) return;
                  setDescs(function (prev) {
                    const next = Object.assign({}, prev);
                    for (const kk in d.descriptions) {
                      if (Object.prototype.hasOwnProperty.call(d.descriptions, kk)) {
                        next[kk] = d.descriptions[kk];
                      }
                    }
                    return next;
                  });
                })
                .catch(function () {});
            }
          }).catch(function (e) { setSerr(String(e && e.message ? e.message : e)); setSearching(false); });
        };
        const keyOf = (r) => r.source + '/' + r.skillId;
        const onDetail = (item) => {
          const k = keyOf(item);
          if (detailKey === k) { setDetailKey(''); setDetail(null); return; }
          setDetailKey(k); setDetail(null); setSerr('');
          hostCall('preview', { source: item.source, skillId: item.skillId, target: target, projectPath: pp })
            .then(function (r) {
              if (r && r.ok) setDetail({ ok: true, info: r });
              else setDetail({ ok: false, error: (r && r.error) || 'Could not read details.' });
            }).catch(function (e) { setDetail({ ok: false, error: String(e && e.message ? e.message : e) }); });
        };
        const onInstall = (item) => {
          setInstalling(true); clearNote();
          hostCall('install', { source: item.source, skillId: item.skillId, target: target, projectPath: pp })
            .then(function (r) {
              setInstalling(false);
              if (r && r.ok) {
                mark(r.name, null);
                say('OK ' + r.name + ' -> ' + r.dir + ' (' + r.written.length + ' entries, ' + String(r.via) + ')');
                setDetailKey(''); setDetail(null); load(pp);
              } else {
                const d2 = (r && r.error) ? r.error
                  : ((r && r.failed && r.failed.length) ? r.failed.join('; ') : 'unknown error');
                say('FAILED: ' + d2);
              }
            }).catch(function (e) { setInstalling(false); say('FAILED: ' + String(e && e.message ? e.message : e)); });
        };
        const onBrowse = () => {
          pickDirectory().then(
            function (p) { if (typeof p === 'string' && p.length > 0) setSrcPath(p); },
            function () { say('FAILED: ' + tt('noPicker')); },
          );
        };
        const onImport = () => {
          setImporting(true); clearNote();
          hostCall('import-skill', { sourcePath: srcPath, mode: impMode, target: target, projectPath: pp })
            .then(function (r) {
              setImporting(false);
              if (r && r.ok) {
                say('IMPORTED ' + r.name + ' -> ' + r.dir + ' (' + String(r.mode) + ')');
                setSrcPath(''); load(pp);
              } else { say('FAILED: ' + ((r && r.error) || 'import failed')); }
            }).catch(function (e) { setImporting(false); say('FAILED: ' + String(e && e.message ? e.message : e)); });
        };

        const projects = (boot && boot.projects) ? boot.projects : [];
        const all = skills || [];
        const needle = filter.trim().toLowerCase();
        const shown = needle === '' ? all : all.filter(function (s) {
          return (s.name + ' ' + s.description + ' ' + s.source).toLowerCase().indexOf(needle) >= 0;
        });
        const updCount = Object.keys(updates).filter(function (k) {
          return updates[k] !== undefined && updates[k] !== null && updates[k].status === 'update';
        }).length;
        const shortReason = (n2) => {
          if (n2 === 'link') return tt('shortLink');
          if (n2 === 'no-directory') return tt('shortNoDir');
          return tt('shortNotOwned');
        };
        const updateTag = (name) => {
          const u = updates[name];
          if (u === undefined) return null;
          if (u.status === 'update') return h('span', { className: 'dshsk-tag dshsk-new' }, tt('hasUpdate'));
          if (u.status === 'current') return h('span', { className: 'dshsk-tag' }, tt('upToDate'));
          if (u.status === 'no-record') return h('span', { className: 'dshsk-tag' }, tt('noRecord'));
          return h('span', { className: 'dshsk-tag dshsk-warn' }, 'unreachable');
        };

        const renderSkill = (s) => {
          const hasUpd = updates[s.name] !== undefined && updates[s.name] !== null
            && updates[s.name].status === 'update';
          const tags = [h('span', { className: 'dshsk-tag', key: 'src' }, s.source)];
          if (s.userInvocable) tags.push(h('span', { className: 'dshsk-tag', key: 'ui' }, '/' + s.name));
          if (s.mode === 'install' || s.mode === 'link' || s.mode === 'copy') {
            tags.push(h('span', { className: 'dshsk-tag', key: 'mg' },
              s.mode === 'install' ? tt('managed') : tt('imported')));
          }
          if (s.shadowsGlobal) {
            tags.push(h('span', { className: 'dshsk-tag dshsk-warn', key: 'sh' },
              tt('shadows') + ' ' + s.shadowsGlobal));
          }
          const ut = updateTag(s.name);
          if (ut) tags.push(h('span', { key: 'up' }, ut));

          const control = s.togglable
            ? h('div', { className: 'dshsk-ctl', key: 'ctl' },
                h('span', { className: 'dshsk-ctllabel' }, s.modelInvocable ? tt('modeAuto') : tt('modeManual')),
                h(Switch, {
                  checked: !!s.modelInvocable,
                  label: s.modelInvocable ? tt('ctxOn') : tt('ctxOff'),
                  onChange: function (next) { onSetEnabled(s, next); },
                }))
            : h('span', { className: 'dshsk-tag', key: 'ctl',
                title: s.ownerNote === 'link' ? tt('shared') : tt('notOwned') }, shortReason(s.ownerNote));

          const actions = [
            h('button', { className: 'dshsk-btn', key: 'view',
              onClick: function () { onToggleBody(s.name); } },
              openName === s.name ? tt('hide') : tt('view')),
          ];
          if (s.mode === 'install') {
            const st = updates[s.name];
            const fresh = st !== undefined && st.status === 'update';
            const known = st !== undefined && st.status === 'current';
            actions.push(h('button', {
              className: fresh ? 'dshsk-btn dshsk-primary' : 'dshsk-btn',
              key: 'up',
              disabled: updatingName === s.name || known,
              title: known ? tt('noChange') : '',
              onClick: function () { onUpdate(s); },
            }, updatingName === s.name ? tt('updating') : tt('update')));
          }
          if (confirmDel === s.name) {
            actions.push(h('span', { className: 'dshsk-muted', key: 'hint' },
              s.ownerNote === 'link' ? tt('delHintLink') : tt('delHint')));
            actions.push(h('button', { className: 'dshsk-btn dshsk-danger', key: 'cd',
              disabled: deleting === s.name, onClick: function () { onUninstall(s); } }, tt('confirmDel')));
            actions.push(h('button', { className: 'dshsk-btn', key: 'cx',
              onClick: function () { setConfirmDel(''); } }, tt('cancel')));
          } else {
            actions.push(h('button', { className: 'dshsk-btn dshsk-danger', key: 'del',
              disabled: deleting === s.name, onClick: function () { onUninstall(s); } }, tt('uninstall')));
          }

          const kids = [
            h('div', { className: 'dshsk-rowmain', key: 'main' },
              h('div', { className: 'dshsk-rowtext', key: 'txt' },
                h('div', { className: 'dshsk-top', key: 'top' },
                  hasUpd ? h('span', { className: 'dshsk-dot', key: 'dot' }) : null,
                  h('span', { className: 'dshsk-name' }, s.name), tags),
                h('div', { className: 'dshsk-desc', key: 'd' }, s.description),
                s.dir ? h('div', { className: 'dshsk-muted', key: 'p' }, s.dir) : null),
              control),
            h('div', { className: 'dshsk-bar', key: 'b' }, actions),
          ];
          if (openName === s.name && body) {
            kids.push(body.ok
              ? h('pre', { className: 'dshsk-pre', key: 'pre' }, body.content)
              : h('div', { className: 'dshsk-err', key: 'e' }, body.error));
          }
          return h('div', { className: 'dshsk-row', key: s.name }, kids);
        };

        const renderResult = (r) => {
          const k = keyOf(r);
          const d = descs[k];
          const have = inst[k];
          const tags = [
            h('span', { className: 'dshsk-tag', key: 's' }, r.source),
            h('span', { className: 'dshsk-tag', key: 'i' }, tt('installs') + ' ' + r.installs),
          ];
          if (have) tags.push(h('span', { className: 'dshsk-tag dshsk-new', key: 'have' }, tt('alreadyTag')));
          else if (r.installs < 100) tags.push(h('span', { className: 'dshsk-tag dshsk-warn', key: 'l' }, tt('low')));
          const descText = (d === undefined) ? tt('descLoading') : (d.ok ? d.description : '');
          const kids = [
            h('div', { className: 'dshsk-rowtext', key: 'txt' },
              h('div', { className: 'dshsk-top', key: 't' }, h('span', { className: 'dshsk-name' }, r.name), tags),
              descText !== '' ? h('div', { className: 'dshsk-desc', key: 'd' }, descText) : null),
            h('div', { className: 'dshsk-bar', key: 'b' },
              h('button', { className: 'dshsk-btn', key: 'pv',
                onClick: function () { onDetail(r); } }, detailKey === k ? tt('hide') : tt('preview')),
              h('button', { className: have ? 'dshsk-btn' : 'dshsk-btn dshsk-primary', key: 'in',
                disabled: installing, onClick: function () { onInstall(r); } },
                have ? tt('reinstall') : tt('confirm'))),
          ];
          if (detailKey === k) {
            const info = detail && detail.ok ? detail.info : null;
            kids.push(h('div', { className: 'dshsk-detail', key: 'det' },
              detail === null
                ? h('div', { className: 'dshsk-muted' }, tt('loading'))
                : (info === null
                    ? h('div', { className: 'dshsk-err' }, (detail && detail.error) || 'failed')
                    : [
                        info.description ? h('div', { className: 'dshsk-desc', key: 'pd' }, info.description) : null,
                        h('div', { className: 'dshsk-dest', key: 'dst' },
                          h('span', { className: 'dshsk-destlabel' },
                            tt('dest') + ' \u00B7 ' + (info.targetKind === 'project' ? tt('toProject') : tt('toGlobal'))),
                          h('span', { className: 'dshsk-destpath' }, info.destination || '\u2014')),
                        info.content ? h('div', { key: 'doc' },
                          h('div', { className: 'dshsk-ctllabel' }, tt('skillDoc')),
                          h('pre', { className: 'dshsk-pre' }, info.content)) : null,
                        info.noteKey ? h('div', { className: 'dshsk-muted', key: 'nt' }, tt(info.noteKey)) : null,
                        info.warning ? h('div', { className: 'dshsk-warn', key: 'w' }, info.warning) : null,
                        (info.files && info.files.length > 0)
                          ? h('div', { className: 'dshsk-muted', key: 'fl' },
                              info.files.map(function (f) { return f.path; }).join(', ')) : null,
                        (info.skipped && info.skipped.length)
                          ? h('div', { className: 'dshsk-muted', key: 'sk' },
                              tt('skipped') + ': ' + info.skipped.join(', ')) : null,
                      ])),
            );
          }
          return h('div', { className: 'dshsk-row', key: k }, kids);
        };

        const projectOptions = [{ value: '', label: tt('global'), title: tt('global') }].concat(
          projects.map(function (p) { return { value: p.path, label: p.title || baseName(p.path), title: p.path }; }));
        const projectPickOptions = [{ value: '', label: tt('chooseProject'), title: tt('chooseProject') }].concat(
          projects.map(function (p) { return { value: p.path, label: p.title || baseName(p.path), title: p.path }; }));
        const globalTargetPath = (boot && boot.globalRoot) ? String(boot.globalRoot) : tt('global');
        const projectTargetPath = pp ? (pp + '/.dsh/skills') : tt('pickProject');
        const targetSeg = h(Segmented, {
          options: [
            { value: 'global', label: tt('toGlobal'), title: globalTargetPath },
            { value: 'project', label: tt('toProject'), title: projectTargetPath },
          ],
          value: target,
          onChange: function (v) { setTarget(v); setDetailKey(''); setDetail(null); },
        });
        const targetBar = (key) => h('div', { className: 'dshsk-bar', key: key },
          h('span', { className: 'dshsk-ctllabel' }, tt('installTo')),
          targetSeg,
          (target === 'project') ? h(Dropdown, { options: projectPickOptions, value: pp, onChange: onProject }) : null,
          (target === 'project' && pp === '') ? h('span', { className: 'dshsk-warn' }, tt('pickProject')) : null);
        const tabs = h('div', { className: 'dshsk-tabs', key: 'tabs' },
          h('button', { type: 'button', className: view === 'installed' ? 'dshsk-tab dshsk-tab-on' : 'dshsk-tab',
            onClick: function () { setView('installed'); } },
            tt('tabInstalled') + ' (' + all.length + ')' + (updCount > 0 ? '  \u2022' + updCount : '')),
          h('button', { type: 'button', className: view === 'find' ? 'dshsk-tab dshsk-tab-on' : 'dshsk-tab',
            onClick: function () { setView('find'); } }, tt('tabFind')),
          h('button', { type: 'button', className: view === 'import' ? 'dshsk-tab dshsk-tab-on' : 'dshsk-tab',
            onClick: function () { setView('import'); } }, tt('tabImport')));

        const installedHead = [
          h('div', { className: 'dshsk-bar', key: 'bar' },
            h('span', { className: 'dshsk-sec' }, tt('installed')),
            h(Dropdown, { options: projectOptions, value: pp, onChange: onProject }),
            h('button', { className: 'dshsk-btn', key: 'rf',
              onClick: function () { clearNote(); load(pp); }, disabled: busy }, tt('refresh')),
            h('button', { className: 'dshsk-btn dshsk-primary', key: 'ck',
              onClick: onCheck, disabled: checking }, checking ? tt('checking') : tt('checkUpdates'))),
          h('div', { className: 'dshsk-bar', key: 'fltb' },
            h('input', { className: 'dshsk-in', value: filter, placeholder: tt('filter'),
              onChange: function (e) { setFilter(e.target.value); } })),
        ];
        const installedBody = [
          (busy && shown.length === 0) ? h('div', { className: 'dshsk-muted', key: 'ld' }, tt('loading')) : null,
          (!busy && shown.length === 0)
            ? h('div', { className: 'dshsk-muted', key: 'no' }, all.length === 0 ? tt('noSkills') : tt('none')) : null,
          shown.length > 0 ? h('div', { className: 'dshsk-list', key: 'list' }, shown.map(renderSkill)) : null,
          h('div', { className: 'dshsk-muted', key: 'auto' }, tt('autoHint')),
        ];
        const findHead = [
          h('div', { className: 'dshsk-bar', key: 'sb' },
            h('input', {
              className: 'dshsk-in', value: q, placeholder: tt('search'),
              onChange: function (e) { setQ(e.target.value); },
              onKeyDown: function (e) { if (e.key === 'Enter') onSearch(); },
            }),
            h('button', { className: 'dshsk-btn dshsk-primary', key: 'go', onClick: onSearch,
              disabled: searching || q.trim().length < 2 }, searching ? tt('searching') : tt('search'))),
          targetBar('tt2'),
          serr ? h('div', { className: 'dshsk-status dshsk-status-err', key: 'se' }, serr) : null,
        ];
        const findBody = [
          res ? (res.length === 0
            ? h('div', { className: 'dshsk-muted', key: 'nm' }, tt('noMatch'))
            : h('div', { className: 'dshsk-list', key: 'rl' }, res.map(renderResult))) : null,
        ];
        const importHead = [
          h('div', { className: 'dshsk-sec', key: 'ti' }, tt('importTitle')),
          h('div', { className: 'dshsk-bar', key: 'src' },
            h('input', { className: 'dshsk-in', value: srcPath, placeholder: tt('srcPath'),
              onChange: function (e) { setSrcPath(e.target.value); } }),
            h('button', { className: 'dshsk-btn', key: 'br', onClick: onBrowse }, tt('pickDir'))),
          h('div', { className: 'dshsk-bar', key: 'mode' },
            h('span', { className: 'dshsk-ctllabel' }, tt('importMode')),
            h(Segmented, {
              options: [
                { value: 'link', label: tt('modeLink'), title: tt('linkHint') },
                { value: 'copy', label: tt('modeCopy'), title: tt('copyHint') },
              ],
              value: impMode, onChange: setImpMode,
            })),
          targetBar('tgt'),
          h('div', { className: 'dshsk-bar', key: 'go' },
            h('button', { className: 'dshsk-btn dshsk-primary', onClick: onImport,
              disabled: importing || srcPath.trim().length === 0 },
              importing ? tt('importing') : tt('doImport'))),
          h('div', { className: 'dshsk-muted', key: 'hint' }, impMode === 'link' ? tt('linkHint') : tt('copyHint')),
          h('div', { className: 'dshsk-muted', key: 'nu' }, tt('importNoUpdate')),
        ];

        const currentHead = view === 'installed' ? installedHead : (view === 'find' ? findHead : importHead);
        const currentBody = view === 'installed' ? installedBody : (view === 'find' ? findBody : []);
        const errForView = view === 'installed' ? err : '';
        const noteForView = (note !== null && note.v === view) ? note.text : '';
        const statusText = errForView !== '' ? errForView : noteForView;
        const statusErr = errForView !== '' || noteForView.indexOf('FAILED') === 0;

        return h('div', { className: 'dshsk-wrap' },
          h('div', { className: 'dshsk-head' }, [
            h('div', { className: 'dshsk-bar', key: 'title' }, h('span', { className: 'dshsk-sec' }, tt('title'))),
            tabs,
            h('div', {
              className: statusErr ? 'dshsk-status dshsk-status-err' : 'dshsk-status', key: 'st',
            }, statusText),
          ].concat(currentHead)),
          h('div', { className: 'dshsk-body' }, currentBody));
      }

      return Panel;
    }

    /** Required client services: the slot registry, the locale, and the folder picker. */
    const inject = ['slots', 'locale', 'uiWorkspace'];

    /**
     * Client plugin body.
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-skills-panel';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'dsh-skills-panel: panel stylesheet');

      // The settings dialog mounts when the user opens it and unmounts on close,
      // so the nav row has to be marked whenever it appears rather than once at
      // load. The observer also re-marks if React replaces the row node.
      //
      // The mark has to land before the browser paints the freshly mounted
      // dialog, or the shell's gear fallback is on screen for a moment and then
      // swaps to the cap. A MutationObserver callback already runs as a microtask
      // at the end of React's commit — after the nodes are in the DOM, before the
      // frame is painted — so the scan happens right there, with no timer in
      // between. The cost of being that hot is bounded two ways: the callback
      // inspects only the nodes that were just added, and it returns immediately
      // while our marker is still mounted, which is the state a streaming
      // conversation mutates through. The debounced document-wide sweep is kept
      // only as a backstop, for a row that somehow arrives outside the subtree we
      // were shown.
      ctx.effect(() => {
        let row = markNavRowIn(document);
        if (typeof MutationObserver !== 'function' || !document.body) return () => {};

        const isMarked = () => row !== null && row.isConnected && row.hasAttribute(NAV_ATTR);

        let sweep = 0;
        const backstop = () => {
          if (sweep !== 0) return;
          sweep = setTimeout(() => {
            sweep = 0;
            if (isMarked()) return;
            row = markNavRowIn(document) || row;
          }, NAV_SWEEP_MS);
        };

        const observer = new MutationObserver((records) => {
          if (isMarked()) return;
          for (const record of records) {
            for (const node of record.addedNodes) {
              // A label written into an already-mounted row arrives as a text
              // node, so resolve the enclosing button before giving up on it.
              if (node.nodeType === 3) {
                const owner = enclosingButton(node);
                if (owner !== null && markNavButton(owner) !== null) { row = owner; return; }
                continue;
              }
              if (node.nodeType !== 1) continue;
              const hit = markNavRowIn(node);
              if (hit !== null) { row = hit; return; }
            }
          }
          // Nothing in what was just added: re-check the document once the burst
          // settles, rather than walking it on every mutation batch.
          backstop();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
          if (sweep !== 0) clearTimeout(sweep);
        };
      }, 'dsh-skills-panel: settings nav glyph');

      const locale = ctx.locale;
      const pickDict = (id) => (/^zh/i.test(String(id || '')) ? ZH : EN);
      const activeId = () => {
        try {
          const s = locale.getSnapshot();
          return String((s && s.active) || '');
        } catch (e) { return ''; }
      };

      let bound = null;
      try {
        let ids = [];
        try {
          const snap = locale.getSnapshot();
          ids = Array.isArray(snap && snap.locales) ? snap.locales.map((d) => String(d.id)) : [];
        } catch (e) { /* fall back to the known pair */ }
        if (ids.length === 0) ids = ['en', 'zh'];
        for (const id of ids) {
          const off = locale.register(NS, id, pickDict(id));
          // The dictionary registration outlives the row, so tie it to the fiber.
          if (typeof off === 'function') ctx.effect(() => off);
        }
        bound = typeof locale.bind === 'function' ? locale.bind(NS) : null;
      } catch (e) { bound = null; }

      const translate = (key) => {
        if (bound !== null) {
          try {
            const v = bound(key);
            if (typeof v === 'string' && v !== key && v.length > 0) return v;
          } catch (e) { /* fall through to the literal dictionary */ }
        }
        const d = pickDict(activeId());
        return d[key] || EN[key] || key;
      };

      // One shared update store per mounted plugin: the idle check publishes
      // into it and the panel subscribes, so opening settings never re-checks.
      let store = {};
      const subs = [];
      const api = {
        get: () => store,
        publish: (scopeKey, updates) => {
          const next = Object.assign({}, store);
          next[scopeKey] = updates;
          store = next;
          for (const fn of subs.slice()) { try { fn(store); } catch (e) { /* subscriber fault */ } }
        },
        subscribe: (fn) => {
          subs.push(fn);
          return () => {
            const i = subs.indexOf(fn);
            if (i >= 0) subs.splice(i, 1);
          };
        },
      };

      const subscribeLocale = (fn) => {
        try {
          return locale.subscribe(fn);
        } catch (e) { return undefined; }
      };

      // One background sweep per page load, after the first paint. Deliberately
      // not an interval: the check costs one host round trip per installed skill.
      if (typeof setTimeout === 'function') {
        let alive = true;
        const timer = setTimeout(() => {
          if (!alive) return;
          hostCall('bootstrap', {}).then((b) => {
            if (!alive) return;
            const scopes = [''];
            if (b && Array.isArray(b.projects)) {
              for (const p of b.projects) { if (p && p.path) scopes.push(String(p.path)); }
            }
            let i = 0;
            const step = () => {
              if (!alive || i >= scopes.length) return;
              const sc = scopes[i];
              i += 1;
              hostCall('check-updates', { projectPath: sc }).then((r) => {
                if (!alive) return;
                if (r && r.ok) api.publish(sc, r.updates || {});
                step();
              }, () => { if (alive) step(); });
            };
            step();
          }, () => {});
        }, IDLE_MS);
        ctx.effect(() => () => {
          alive = false;
          clearTimeout(timer);
        }, 'dsh-skills-panel: idle update check');
      }

      const Panel = createPanel(ctx, { translate, store: api, subscribeLocale });
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'skills', order: 25, label: () => translate('title') },
        Panel,
      ));
    }

    /**
     * One call into the host route.
     *
     * The route answers a JSON envelope and is same-origin, so the browser
     * attaches the platform's login cookie automatically. Transport faults and
     * failure envelopes are folded into the single `{ok:…}` shape the panel
     * speaks, so no caller has to tell them apart.
     *
     * @param method - endpoint name, matching a host-core method.
     * @param args - JSON payload.
     * @returns `{ok: true, …}` or `{ok: false, error}`.
     */
    function hostCall(method, args) {
      let pending;
      try {
        pending = fetch(CHANNEL + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args || {}),
        });
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return Promise.resolve(pending).then(
        (res) =>
          res.json().then(
            (env) => {
              if (env && env.ok) return env.value;
              const msg = env && env.error
                ? (env.error.message || env.error.code || 'host call failed')
                : 'HTTP ' + res.status;
              return { ok: false, error: String(msg) };
            },
            () => ({ ok: false, error: 'HTTP ' + res.status + ' with a non-JSON body' }),
          ),
        (e) => ({ ok: false, error: String(e && e.message ? e.message : e) }),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
