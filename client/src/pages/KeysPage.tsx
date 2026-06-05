import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import type { ApiKey, Platform } from '../../../shared/types'
import { Pencil, ExternalLink, X } from 'lucide-react'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

function GetKeyLink({ url }: { url: string }) {
  const { t } = useTranslation()
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {t('pages.keys.getKey')}
      <ExternalLink className="size-3" />
    </a>
  )
}

// `url` points to each provider's key-management / signup page so the Keys page
// can show a "Get API key" shortcut (#137). OpenCode Zen's key is free from
// opencode.ai/auth — no card needed; billing only applies to paid models (#128).
// `keyless: true` providers (Kilo's anonymous free tier) need no API key — the
// form disables the key field and submits a sentinel the backend stores so
// routing treats the platform as configured.
const PLATFORMS: { value: Platform; label: string; url: string; keyless?: boolean }[] = [
  { value: 'google', label: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
  { value: 'groq', label: 'Groq', url: 'https://console.groq.com/keys' },
  { value: 'cerebras', label: 'Cerebras', url: 'https://cloud.cerebras.ai' },
  { value: 'sambanova', label: 'SambaNova', url: 'https://cloud.sambanova.ai' },
  { value: 'nvidia', label: 'NVIDIA NIM', url: 'https://build.nvidia.com/settings/api-keys' },
  { value: 'mistral', label: 'Mistral', url: 'https://console.mistral.ai/api-keys/' },
  { value: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/keys' },
  { value: 'github', label: 'GitHub Models', url: 'https://github.com/settings/tokens' },
  { value: 'cohere', label: 'Cohere', url: 'https://dashboard.cohere.com/api-keys' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI', url: 'https://dash.cloudflare.com' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)', url: 'https://z.ai/manage-apikey/apikey-list' },
  { value: 'ollama', label: 'Ollama Cloud', url: 'https://ollama.com/settings/keys' },
  { value: 'kilo', label: 'Kilo Gateway (no key needed)', url: 'https://app.kilo.ai', keyless: true },
  { value: 'pollinations', label: 'Pollinations (anon ok)', url: 'https://pollinations.ai' },
  { value: 'llm7', label: 'LLM7 (anon ok)', url: 'https://llm7.io' },
  { value: 'huggingface', label: 'HuggingFace Router', url: 'https://huggingface.co/settings/tokens' },
  { value: 'opencode', label: 'OpenCode Zen (free key)', url: 'https://opencode.ai/auth' },
]

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500', 
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabelKey: Record<string, string> = {
  healthy: 'pages.keys.statusHealthy',
  rate_limited: 'pages.keys.statusRateLimited',
  invalid: 'pages.keys.statusInvalid',
  error: 'pages.keys.statusError',
  unknown: 'pages.keys.statusUnknown',
}

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

function UnifiedKeySection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data, isError } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  function copy() {
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">{t('pages.keys.header')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('pages.keys.unifiedKeyDescription')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending || isError}
        >
          {t('pages.keys.regenerate')}
        </Button>
      </div>

      {isError ? (
         <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
           {t('pages.keys.cantReachServer', { baseUrl: baseUrl.replace('/v1', '') })}
         </div>
       ) : (
         <div className="flex items-center gap-2">
           <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate tabular-nums">
             {showKey ? apiKey : masked}
           </code>
           <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
             {showKey ? t('pages.keys.hide') : t('pages.keys.show')}
           </Button>
           <Button variant="outline" size="sm" onClick={copy}>
             {copied ? t('pages.keys.copied') : t('pages.keys.copy')}
           </Button>
         </div>
       )}

        <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <span className="text-muted-foreground">{t('pages.keys.baseUrl')}</span>
          <code className="font-mono">{baseUrl}</code>
          <span className="text-muted-foreground">{t('pages.keys.chat')}</span>
          <code className="font-mono">/v1/chat/completions</code>
          <span className="text-muted-foreground">{t('pages.keys.responses')}</span>
          <code className="font-mono">/v1/responses</code>
          <span className="text-muted-foreground">{t('pages.keys.embeddings')}</span>
          <code className="font-mono">/v1/embeddings <span className="text-muted-foreground">— {t('pages.keys.embeddingsModelHint')}</span></code>
        </div>
      </section>
    )
  }

function CustomProviderSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [discoveryResult, setDiscoveryResult] = useState<string | null>(null)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [modelsFetchError, setModelsFetchError] = useState('')
  const [showModelDialog, setShowModelDialog] = useState(false)
  const [selectedModelInDialog, setSelectedModelInDialog] = useState('')
  const [modelFilterQuery, setModelFilterQuery] = useState('')

  const addCustom = useMutation({
    mutationFn: (body: { baseUrl: string; model?: string; displayName?: string; apiKey?: string; label?: string }) =>
      apiFetch('/api/keys/custom', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      if (data.autoDiscovered) {
        setDiscoveryResult(t('pages.keys.discovered', { count: data.modelCount ?? 0 }))
      } else if (data.warning) {
        setDiscoveryResult(data.warning)
      } else {
        setDiscoveryResult(null)
      }
      if (!data.warning) {
        setBaseUrl('')
        setModel('')
        setDisplayName('')
        setLabel('')
        setApiKey('')
        setFetchedModels([])
        setModelsFetchError('')
        setShowModelDialog(false)
        setSelectedModelInDialog('')
        setModelFilterQuery('')
      }
    },
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!baseUrl) return
    addCustom.mutate({
      baseUrl,
      model: model || undefined,
      displayName: displayName || undefined,
      apiKey: apiKey || undefined,
      label: label || undefined,
    })
  }

  const isAutoDiscovering = addCustom.isPending && !model

  const fetchModelList = async () => {
    if (!baseUrl) return
    setIsFetchingModels(true)
    setModelsFetchError('')
    setFetchedModels([])
    try {
      const res = await apiFetch('/api/keys/custom/discover', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey: apiKey || undefined }),
      })
      const data = await res.json()
      if (data.models?.length) {
        setFetchedModels(data.models)
        setShowModelDialog(true)
        setModelFilterQuery('')
        setSelectedModelInDialog('')
      } else {
        setModelsFetchError(t('pages.keys.modelFetchFailed'))
      }
    } catch (e) {
      console.error(e)
      setModelsFetchError(t('pages.keys.modelFetchFailed'))
    } finally {
      setIsFetchingModels(false)
    }
  }

  const confirmModelSelection = () => {
    if (selectedModelInDialog) {
      setModel(selectedModelInDialog)
      if (!displayName) setDisplayName(selectedModelInDialog)
    }
    setShowModelDialog(false)
    setSelectedModelInDialog('')
    setModelFilterQuery('')
  }

  const filteredModels = fetchedModels.filter(m =>
    m.toLowerCase().includes(modelFilterQuery.toLowerCase())
  )

  return (
    <section>
      <h2 className="text-sm font-medium mb-1">{t('pages.keys.customModelTitle')}</h2>
      <p className="text-xs text-muted-foreground mb-3">
        {t('pages.keys.customModelDesc')}
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-3xl border p-4 bg-card">
        <div className="space-y-1.5 flex-1 min-w-[240px]">
          <Label className="text-xs">{t('pages.keys.baseUrl')}</Label>
          <Input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:11434/v1"
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('pages.keys.apiKey')}</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={t('pages.keys.optional')}
            className="w-[150px] font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('pages.keys.label')}</Label>
          <Input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={t('pages.keys.optional')}
            className="w-[150px]"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label className="text-xs">{t('pages.keys.model')}</Label>
            <button
              type="button"
              onClick={fetchModelList}
              disabled={!baseUrl || isFetchingModels}
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isFetchingModels ? t('pages.keys.fetchingModels') : t('pages.keys.fetchModels')}
            </button>
          </div>
          <Input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="qwen3:4b"
            className="w-[280px] font-mono text-xs"
          />
          {modelsFetchError && (
            <p className="text-xs text-destructive">{modelsFetchError}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('pages.keys.displayName')}</Label>
          <Input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder={t('pages.keys.optional')}
            className="w-[150px]"
          />
        </div>
        <Button type="submit" size="sm" disabled={!baseUrl || addCustom.isPending}>
          {isAutoDiscovering ? t('pages.keys.discovering') : addCustom.isPending ? t('pages.keys.adding') : t('pages.keys.addModel')}
        </Button>
      </form>

      {showModelDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background rounded-2xl border shadow-lg w-[500px] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-sm font-medium">{t('pages.keys.selectModel')}</h3>
              <button
                type="button"
                onClick={() => setShowModelDialog(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="p-4">
              <Input
                value={modelFilterQuery}
                onChange={e => setModelFilterQuery(e.target.value)}
                placeholder={t('pages.keys.filterModels')}
                className="mb-3"
              />
              <div className="overflow-y-auto max-h-[50vh] space-y-1">
                {filteredModels.map(m => (
                  <div
                    key={m}
                    onClick={() => setSelectedModelInDialog(m)}
                    className={`px-3 py-2 rounded-lg cursor-pointer text-sm font-mono ${
                      selectedModelInDialog === m
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted'
                    }`}
                  >
                    {m}
                  </div>
                ))}
                {filteredModels.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {t('pages.keys.noModelsFound')}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t">
              <Button variant="outline" size="sm" onClick={() => setShowModelDialog(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={confirmModelSelection} disabled={!selectedModelInDialog}>
                {t('common.ok')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {addCustom.isError && (
        <p className="text-destructive text-xs mt-2">{(addCustom.error as Error).message}</p>
      )}
      {discoveryResult && (
        <p className={addCustom.isError ? 'text-destructive text-xs mt-2' : 'text-muted-foreground text-xs mt-2'}>{discoveryResult}</p>
      )}
    </section>
  )
}

export default function KeysPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const togglePlatform = useMutation({
    mutationFn: ({ platform, enabled }: { platform: string; enabled: boolean }) =>
      apiFetch(`/api/keys/platform/${platform}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const updateKey = useMutation({
    mutationFn: ({ id, label, enabled }: { id: number; label?: string; enabled?: boolean }) =>
      apiFetch(`/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...(label !== undefined && { label }), ...(enabled !== undefined && { enabled }) }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      setEditingKeyId(null)
      setEditingLabel('')
    },
  })

  function startEditing(key: ApiKey) {
    setEditingKeyId(key.id)
    setEditingLabel(key.label)
  }

  function cancelEditing() {
    setEditingKeyId(null)
    setEditingLabel('')
  }

  function saveEditing(id: number) {
    if (editingLabel !== undefined) {
      updateKey.mutate({ id, label: editingLabel })
    }
  }

  useEffect(() => {
    if (editingKeyId !== null && editInputRef.current) {
      editInputRef.current.focus()
    }
  }, [editingKeyId])

  const needsAccountId = platform === 'cloudflare'
  const isKeyless = PLATFORMS.find(p => p.value === platform)?.keyless ?? false

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform) return
    if (!isKeyless && !apiKey) return
    if (needsAccountId && !accountId) return
    // Keyless providers submit an empty key; the backend stores a sentinel.
    const key = isKeyless ? '' : (needsAccountId ? `${accountId}:${apiKey}` : apiKey)
    addKey.mutate({ platform, key, label: label || undefined })
  }

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)

  const regularGroups = PLATFORMS.map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)

  const customKeysList = keys.filter(k => k.platform === 'custom')
  const customGroups = customKeysList.map(k => ({
    value: `custom:${k.id}`,
    label: k.label || k.baseUrl || t('pages.keys.customProvider'),
    url: '',
    keys: [k],
    isCustom: true as const,
  }))

  const grouped = [...regularGroups, ...customGroups]

  return (
    <div>
       <PageHeader
         title={t('pages.keys.header')}
         description={t('pages.keys.description')}
        actions={
          keys.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
              {checkAll.isPending ? t('pages.keys.checkingAll') : t('pages.keys.checkAll')}
            </Button>
          )
        }
      />

      <div className="space-y-8">
        <UnifiedKeySection />

         <section>
           <h2 className="text-sm font-medium mb-3">{t('pages.keys.addProviderKey')}</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-3xl border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('pages.keys.platformLabel')}</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder={t('pages.keys.selectProvider')} />
                </SelectTrigger>
                 <SelectContent>
                    {PLATFORMS.map(p => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                 </SelectContent>
              </Select>
              {(() => {
                const sel = PLATFORMS.find(p => p.value === platform)
                return sel?.url ? <div className="pt-0.5"><GetKeyLink url={sel.url} /></div> : null
              })()}
            </div>
            {needsAccountId && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('pages.keys.accountId')}</Label>
                <Input
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  placeholder="a1b2c3d4…"
                  className="w-[200px] font-mono text-xs"
                />
              </div>
            )}
            <div className="space-y-1.5 flex-1 min-w-[240px]">
              <Label className="text-xs">{needsAccountId ? t('pages.keys.apiToken') : t('pages.keys.apiKey')}</Label>
              <Input
                type="password"
                value={isKeyless ? '' : apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={isKeyless ? t('pages.keys.noKeyNeeded') : (needsAccountId ? t('pages.keys.bearerToken') : t('pages.keys.pasteKey'))}
                className="font-mono text-xs"
                disabled={isKeyless}
              />
              {isKeyless && (
                <p className="text-[11px] text-muted-foreground">
                  {t('pages.keys.noKeyDescription')}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('pages.keys.label')}</Label>
              <Input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder={t('pages.keys.optional')}
                className="w-[160px]"
              />
            </div>
            <Button type="submit" size="sm" disabled={!platform || (!isKeyless && !apiKey) || (needsAccountId && !accountId) || addKey.isPending}>
              {addKey.isPending ? t('pages.keys.adding') : isKeyless ? t('pages.keys.enable') : t('pages.keys.addKeyButton')}
            </Button>
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
        </section>

        <CustomProviderSection />

         <section>
           <h2 className="text-sm font-medium mb-3">{t('pages.keys.configuredProviders')}</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : keys.length === 0 ? (
            <div className="rounded-3xl border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                {t('pages.keys.noProviders')}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
               {grouped.map(group => (
                  <div key={group.value}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        {'isCustom' in group ? (
                          <Switch
                            checked={group.keys[0]?.enabled ?? false}
                            onCheckedChange={(checked) =>
                              updateKey.mutate({ id: group.keys[0].id, enabled: checked })
                            }
                            disabled={updateKey.isPending}
                          />
                        ) : (
                          <Switch
                            checked={group.keys.some(k => k.enabled)}
                            onCheckedChange={(checked) =>
                              togglePlatform.mutate({ platform: group.value, enabled: checked })
                            }
                            disabled={togglePlatform.isPending}
                          />
                        )}
                        <h3 className="text-sm font-medium">{group.label}</h3>
                        {!('isCustom' in group) && group.url && <GetKeyLink url={group.url} />}
                      </div>
                     <span className="text-xs text-muted-foreground tabular-nums">
                       {t('pages.keys.keyCount', { count: group.keys.length })}
                     </span>
                    </div>
                    {'isCustom' in group && group.keys[0]?.baseUrl && (
                      <p className="text-xs text-muted-foreground mb-2 ml-9 font-mono">
                        {group.keys[0].baseUrl}
                      </p>
                    )}
                  <div className="rounded-2xl border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = h?.status ?? k.status
                      const lastChecked = h?.lastCheckedAt
                      const isEditing = editingKeyId === k.id
                      return (
                        <div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                          <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                          <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                          {isEditing ? (
                            <Input
                              ref={editInputRef}
                              value={editingLabel}
                              onChange={e => setEditingLabel(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveEditing(k.id)
                                if (e.key === 'Escape') cancelEditing()
                              }}
                              onBlur={() => saveEditing(k.id)}
                              className="h-6 w-[160px] text-xs"
                              disabled={updateKey.isPending}
                            />
                          ) : (
                            <>
                              {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                            </>
                          )}
                          <span className="text-xs text-muted-foreground">{t(statusLabelKey[status] ?? status)}</span>
                          <div className="flex-1" />
                          {lastChecked && (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {formatSqliteUtcToLocalTime(lastChecked, { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                          {!isEditing && (
                            <Button variant="ghost" size="xs" onClick={() => startEditing(k)}>
                              <Pencil className="size-3" />
                            </Button>
                          )}
                          <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                            {t('pages.keys.checkKey')}
                          </Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending}>
                            {t('pages.keys.remove')}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
