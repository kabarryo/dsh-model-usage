/**
 * dsh-model-usage — Client half.
 *
 * One pill in `conversation.composer.dock`, beside the shipped stats pills:
 *
 *     5H 14% · W 18% · M 23%
 *
 * Clicking it opens the same menu-surface dialog the shipped stat pills use.
 * The numbers arrive from the Host half's loopback route; nothing here knows
 * the API key, and no request leaves the machine.
 *
 * Refresh model: poll every 3 s while the page is visible. The Host refreshes
 * upstream on its own TTL plus a dirty flag raised by `assistant/message`, so a
 * finished turn lands within one poll without any push channel. The queried
 * `provider` follows the session's model selection, so switching to a model on
 * another route switches the meter — and therefore the credential — with it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React
    const { createPortal } = require('react-dom')

    const ENDPOINT = '/api/dsh-model-usage'
    const POLL_MS = 3000
    const STYLE_ID = 'dsh-model-usage-style'
    const ICON_SIZE = 14

    /** Display order, short label, and the long name used in the dialog. */
    const WINDOWS = [
      { key: 'rolling', short: '5H', name: '5 小时' },
      { key: 'weekly', short: 'W', name: '本周' },
      { key: 'monthly', short: 'M', name: '本月' },
    ]

    const CSS_TEXT = `
.mu-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer}
.mu-pill:hover,.mu-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.mu-pill svg{width:${ICON_SIZE}px;height:${ICON_SIZE}px;flex:none}
.mu-sep{color:var(--dsw-alias-separator-primary);margin:0 4px}
.mu-panel{position:fixed;z-index:1100;box-sizing:border-box;padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default}
.mu-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.mu-rule{margin-bottom:10px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.mu-row{display:grid;grid-template-columns:56px minmax(0,1fr) 40px;align-items:center;gap:10px;margin-top:10px}
.mu-name{color:var(--dsw-alias-label-tertiary)}
.mu-bar{position:relative;display:block;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.mu-fill{position:absolute;top:0;bottom:0;left:0;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.mu-pct{text-align:right;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.mu-reset{margin:2px 0 0 66px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mu-note{margin-top:12px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mu-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.mu-btn{border:0;padding:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;cursor:pointer}
.mu-btn:hover{text-decoration:underline}
.mu-error{margin-top:10px;color:var(--dsw-alias-state-error-primary);line-height:16px}
/* 五档用量色（绿 / 黄 / 橙 / 红 / 红+⚠）。放在最后，靠同权重的后手声明
   盖住 .mu-pct / .mu-name / .mu-reset 的静态色。橙色没有专用 token，用黄红
   混合；不支持 color-mix 的引擎退回上一行声明的黄色，不会出现空条。 */
.mu-t-ok{color:var(--dsw-alias-state-success-primary)}
.mu-t-warm{color:var(--dsw-alias-state-warn-primary)}
.mu-t-hot{color:var(--dsw-alias-state-warn-primary)}
.mu-t-hot{color:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 50%,var(--dsw-alias-state-error-primary))}
.mu-t-danger{color:var(--dsw-alias-state-error-primary)}
.mu-fill.mu-t-ok{background:var(--dsw-alias-state-success-primary)}
.mu-fill.mu-t-warm{background:var(--dsw-alias-state-warn-primary)}
.mu-fill.mu-t-hot{background:var(--dsw-alias-state-warn-primary)}
.mu-fill.mu-t-hot{background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 50%,var(--dsw-alias-state-error-primary))}
.mu-fill.mu-t-danger{background:var(--dsw-alias-state-error-primary)}
`

    /**
     * Inject the stylesheet once for every mounted pill.
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
    }

    /** A hook-shaped stand-in when the host slot face omits `useProjection`. */
    const noProjection = () => undefined

    /**
     * Two-digit zero pad.
     * @param {number} value - number.
     * @returns {string} padded text.
     */
    const pad2 = value => String(value).padStart(2, '0')

    /**
     * Usage band for one window: green below 70, then yellow, orange and red
     * every ten points, so the jump into "about to run out" is gradual.
     * @param {number} percent - used share.
     * @returns {'ok' | 'warm' | 'hot' | 'danger' | ''} band id, empty when unknown.
     */
    function tierOf(percent) {
      if (!Number.isFinite(percent)) return ''
      if (percent >= 90) return 'danger'
      if (percent >= 80) return 'hot'
      if (percent >= 70) return 'warm'
      return 'ok'
    }

    /**
     * Text tone class. Green stays neutral on purpose: only the bands that ask
     * for attention colour the number.
     * @param {string} tier - band id.
     * @returns {string} tone class, empty for `ok` and unknown.
     */
    function toneClass(tier) {
      return tier === '' || tier === 'ok' ? '' : `mu-t-${tier}`
    }

    /**
     * Bar fill classes.
     * @param {string} tier - band id.
     * @returns {string} class list.
     */
    function fillClass(tier) {
      return tier === '' ? 'mu-fill' : `mu-fill mu-t-${tier}`
    }

    /**
     * Whether a window is spent: the percentage reached the cap, or the
     * endpoint reports a status other than `ok`/`unknown`.
     * @param {{ percent: number, status: string } | null} value - window value.
     * @returns {boolean} true when no more usage is allowed in this window.
     */
    function isExhausted(value) {
      if (value === null || value === undefined) return false
      if (value.percent >= 100) return true
      return value.status !== 'ok' && value.status !== 'unknown'
    }

    /**
     * Absolute reset time: a bare clock today, a date for anything later.
     * @param {string | null} iso - reset instant.
     * @returns {string | null} formatted text, or null when unparseable.
     */
    function formatClock(iso) {
      const date = new Date(iso ?? '')
      if (Number.isNaN(date.getTime())) return null
      const now = new Date()
      const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
      if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return clock
      if (date.getFullYear() === now.getFullYear()) return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock}`
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    /**
     * Countdown to a reset instant.
     * @param {string | null} iso - reset instant.
     * @param {number} now - reference epoch milliseconds.
     * @returns {string | null} formatted countdown, or null when unparseable.
     */
    function formatRemaining(iso, now) {
      const target = Date.parse(iso ?? '')
      if (!Number.isFinite(target)) return null
      const delta = target - now
      if (delta <= 0) return '即将重置'
      const minutes = Math.floor(delta / 60_000)
      const days = Math.floor(minutes / 1_440)
      const hours = Math.floor((minutes % 1_440) / 60)
      const rest = minutes % 60
      if (days > 0) return `还剩 ${days} 天 ${hours} 小时`
      if (hours > 0) return `还剩 ${hours} 小时 ${rest} 分`
      return `还剩 ${Math.max(1, rest)} 分`
    }

    /**
     * One-line description used as the pill's accessible name.
     * @param {Array<{ short: string, value: { percent: number } | null }>} rows - window rows.
     * @returns {string} readable summary.
     */
    function summaryOf(rows) {
      const parts = rows.map((row) => {
        if (row.value === null) return `${row.short} 无数据`
        const percent = Math.round(row.value.percent)
        return isExhausted(row.value) ? `${row.short} ${percent}%，已用完` : `${row.short} ${percent}%`
      })
      return `模型额度：${parts.join('，')}`
    }

    /**
     * Contain any render failure to this pill: a broken widget must not take
     * the composer dock down with it.
     */
    class PillBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('[dsh-model-usage] pill failed', error)
      }

      render() {
        return this.state.failed === true ? null : this.props.children
      }
    }

    /**
     * Slot entry: the boundary plus the pill, so the slot's props pass through.
     * @param {object} props - session standard props.
     * @returns {object | null} the pill tree.
     */
    function ModelUsageEntry(props) {
      return h(PillBoundary, null, h(ModelUsagePill, props))
    }

    /** The composer-dock pill. */
    function ModelUsagePill(props) {
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : noProjection
      // Session standard props: the projection carries { lastUsed, next }; the
      // pending selection is what the next request will use.
      const selection = useProjection('modelSelection')
      const provider = selection?.next?.provider ?? selection?.lastUsed?.provider ?? null

      const [snapshot, setSnapshot] = useState(null)
      const [nonce, setNonce] = useState(0)
      const [open, setOpen] = useState(false)
      const [pos, setPos] = useState(null)
      const [, setClock] = useState(0)
      const anchorRef = useRef(null)
      const panelRef = useRef(null)

      useEffect(() => { ensureStyles() }, [])

      useEffect(() => {
        let alive = true
        let timer = null
        let forceNext = nonce > 0
        const load = async () => {
          if (typeof document !== 'undefined' && document.hidden) {
            timer = setTimeout(load, POLL_MS)
            return
          }
          try {
            const query = new URLSearchParams()
            if (typeof provider === 'string' && provider !== '') query.set('provider', provider)
            if (forceNext) query.set('force', '1')
            forceNext = false
            const response = await fetch(`${ENDPOINT}?${query.toString()}`, { cache: 'no-store' })
            const data = await response.json()
            if (alive && data !== null && typeof data === 'object') setSnapshot(data)
          } catch { /* keep the last good reading; the next poll retries */ }
          if (alive) timer = setTimeout(load, POLL_MS)
        }
        void load()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [provider, nonce])

      // Countdowns only tick while the dialog is open.
      useEffect(() => {
        if (!open) return undefined
        const id = setInterval(() => { setClock(value => value + 1) }, 1000)
        return () => { clearInterval(id) }
      }, [open])

      const place = useCallback(() => {
        const anchor = anchorRef.current
        if (anchor === null) return
        const rect = anchor.getBoundingClientRect()
        const width = Math.min(320, window.innerWidth - 24)
        const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12)
        setPos({ left, width, bottom: Math.max(12, window.innerHeight - rect.top + 8) })
      }, [])

      useEffect(() => {
        if (!open) { setPos(null); return undefined }
        place()
        const onKey = event => { if (event.key === 'Escape') setOpen(false) }
        const onDown = event => {
          const target = event.target
          if (panelRef.current?.contains(target) === true) return
          if (anchorRef.current?.contains(target) === true) return
          setOpen(false)
        }
        const onResize = () => { place() }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        window.addEventListener('resize', onResize)
        window.addEventListener('scroll', onResize, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
          window.removeEventListener('resize', onResize)
          window.removeEventListener('scroll', onResize, true)
        }
      }, [open, place])

      const active = snapshot?.active ?? null
      const usage = snapshot?.usage ?? null
      const rows = WINDOWS.map(def => ({ ...def, value: usage?.[def.key] ?? null }))
      const exhausted = rows.some(row => isExhausted(row.value))
      const loading = snapshot === null
      const failed = snapshot?.ok === false || (snapshot?.error !== undefined && snapshot?.error !== null)

      if (loading || active === null) return null

      const refresh = () => { setNonce(value => value + 1) }
      const ariaLabel = usage === null
        ? `模型额度不可用：${snapshot?.error?.message ?? '暂无数据'}`
        : summaryOf(rows)

      const pill = h('button', {
        type: 'button',
        className: 'mu-pill',
        ref: anchorRef,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': ariaLabel,
        title: active.label,
        onClick: () => { setOpen(value => !value) },
      },
      exhausted
        ? h('svg', { viewBox: '0 0 16 16', className: 'mu-t-danger', 'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M8 1.4 15 14H1z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linejoin': 'round' }),
          h('path', { d: 'M8 5.6v4.1', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
          h('circle', { cx: 8, cy: 11.9, r: 0.85, fill: 'currentColor' }))
        : h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
          h('path', {
            d: 'M8 1.6a6.4 6.4 0 1 1-6.02 8.58l1.86-.66A4.4 4.4 0 1 0 8 3.6z',
            fill: 'currentColor',
          }),
          h('path', { d: 'M3 3.4l4.3 4.3-1.3 1.3L1.7 4.7z', fill: 'currentColor' })),
      usage === null
        ? h('span', { className: failed ? 'mu-t-danger' : undefined }, '额度 —')
        : rows.map((row, index) => h(React.Fragment, { key: row.key },
          index > 0 ? h('span', { className: 'mu-sep', 'aria-hidden': 'true' }, '·') : null,
          h('span', {
            className: toneClass(isExhausted(row.value) ? 'danger' : tierOf(row.value?.percent ?? NaN)) || undefined,
          },
          row.short,
          ' ',
          row.value === null ? '—' : `${Math.round(row.value.percent)}%`))))

      if (!open) return pill

      const now = snapshot?.now ?? Date.now()
      const age = usage === null || snapshot?.fetchedAt === null || snapshot?.fetchedAt === undefined
        ? null
        : Math.max(0, Math.round(((snapshot.now ?? Date.now()) - snapshot.fetchedAt) / 1000))

      return h(React.Fragment, null,
        pill,
        createPortal(h('div', {
          ref: panelRef,
          className: 'mu-panel',
          role: 'dialog',
          'aria-label': `${active.label} 订阅额度`,
          style: pos === null
            ? { left: 12, bottom: 12, width: 320, visibility: 'hidden' }
            : { left: pos.left, bottom: pos.bottom, width: pos.width },
        },
        h('div', { className: 'mu-title' },
          h('span', null, active.label),
          h('span', { className: exhausted ? 'mu-t-danger' : undefined },
            exhausted ? '⚠ 已用完' : '订阅额度')),
        h('div', { className: 'mu-rule', 'aria-hidden': 'true' }),
        usage === null
          ? h('div', { className: 'mu-error' }, snapshot?.error?.message ?? '暂时无法获取用量')
          : rows.map((row) => {
            const spent = isExhausted(row.value)
            const rowTone = spent ? 'danger' : tierOf(row.value?.percent ?? NaN)
            const clock = formatClock(row.value?.resetsAt ?? null)
            const reset = spent
              ? (clock === null ? '已用完，等待重置' : `已用完，等待 ${clock} 重置`)
              : [
                row.value !== null && row.value.status !== 'ok' && row.value.status !== 'unknown'
                  ? `状态 ${row.value.status}`
                  : null,
                clock === null ? null : `${clock} 重置`,
                formatRemaining(row.value?.resetsAt ?? null, now),
              ].filter(Boolean).join(' · ')
            return h(React.Fragment, { key: row.key },
              h('div', { className: 'mu-row' },
                h('span', { className: spent ? 'mu-name mu-t-danger' : 'mu-name' },
                  spent ? `⚠ ${row.name}` : row.name),
                h('span', { className: 'mu-bar' },
                  h('i', {
                    className: fillClass(rowTone),
                    style: { width: `${row.value === null ? 0 : Math.max(2, Math.round(row.value.percent))}%` },
                  })),
                h('span', { className: `mu-pct ${toneClass(rowTone)}`.trim() },
                  row.value === null ? '—' : `${Math.round(row.value.percent)}%`)),
              h('div', { className: `mu-reset ${rowTone === 'danger' ? 'mu-t-danger' : ''}`.trim() },
                row.value === null ? '无数据' : reset))
          }),
        h('div', { className: 'mu-note' }, '订阅级用量，不区分模型；数据来自用量端点'),
        h('div', { className: 'mu-foot' },
          h('span', null, age === null ? '尚未成功获取' : `更新于 ${age < 60 ? `${age} 秒前` : `${Math.round(age / 60)} 分钟前`}`),
          h('button', { type: 'button', className: 'mu-btn', onClick: refresh }, '刷新'))), document.body))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'model-usage',
          order: 1,
        }, ModelUsageEntry))
      },
    }
  },
})
