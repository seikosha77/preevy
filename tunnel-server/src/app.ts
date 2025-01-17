import Fastify from 'fastify'
import { fastifyRequestContext } from '@fastify/request-context'
import http from 'http'
import { Logger } from 'pino'
import { KeyObject } from 'crypto'
import { SessionStore } from './session.js'
import { Authenticator, Claims } from './auth.js'
import { ActiveTunnelStore } from './tunnel-store/index.js'
import { editUrl } from './url.js'
import { Proxy } from './proxy/index.js'

export const buildLoginUrl = ({ baseUrl, env, returnPath }: {
  baseUrl: URL
  env: string
  returnPath?: string
}) => editUrl(baseUrl, {
  hostname: `auth.${baseUrl.hostname}`,
  queryParams: {
    env,
    ...returnPath ? { returnPath } : {},
  },
  path: '/login',
}).toString()

export const app = (
  { proxy, sessionStore, baseUrl, activeTunnelStore, log, saasBaseUrl, authFactory }: {
    log: Logger
    baseUrl: URL
    saasBaseUrl?: string
    sessionStore: SessionStore<Claims>
    activeTunnelStore: ActiveTunnelStore
    proxy: Proxy
    authFactory: (client: { publicKey: KeyObject; publicKeyThumbprint: string }) => Authenticator
  },
) => {
  const a = Fastify({
    serverFactory: handler => {
      const baseHostname = baseUrl.hostname
      const authHostname = `auth.${baseHostname}`
      const apiHostname = `api.${baseHostname}`

      const isNonProxyRequest = ({ headers }: http.IncomingMessage) => {
        const host = headers.host?.split(':')?.[0]
        return (host === authHostname) || (host === apiHostname)
      }

      const server = http.createServer((req, res) => {
        if (req.url !== '/healthz') {
          log.debug('request %j', { method: req.method, url: req.url, headers: req.headers })
        }
        const proxyHandler = !isNonProxyRequest(req) && proxy.routeRequest(req)
        return proxyHandler ? proxyHandler(req, res) : handler(req, res)
      })
        .on('upgrade', (req, socket, head) => {
          log.debug('upgrade', req.url)
          const proxyHandler = !isNonProxyRequest(req) && proxy.routeUpgrade(req)
          if (proxyHandler) {
            return proxyHandler(req, socket, head)
          }

          log.warn('upgrade request %j not found', { url: req.url, host: req.headers.host })
          socket.end('Not found')
          return undefined
        })
      return server
    },
    logger: log,
  })
    .register(fastifyRequestContext)
    .get<{Params: { profileId: string } }>('/profiles/:profileId/tunnels', { schema: {
      params: { type: 'object',
        properties: {
          profileId: { type: 'string' },
        },
        required: ['profileId'] },
    } }, async (req, res) => {
      const { profileId } = req.params
      const tunnels = (await activeTunnelStore.getByPkThumbprint(profileId))
      if (!tunnels?.length) return []

      const auth = authFactory(tunnels[0])

      const result = await auth(req.raw)

      if (!result.isAuthenticated) {
        res.statusCode = 401
        return await res.send('Unauthenticated')
      }

      return await res.send(tunnels.map(t => ({
        envId: t.envId,
        hostname: t.hostname,
        access: t.access,
        meta: t.meta,
      })))
    })

    .get('/healthz', { logLevel: 'warn' }, async () => 'OK')

    .get<{Querystring: {env: string; returnPath?: string}}>('/login', {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            env: { type: 'string' },
            returnPath: { type: 'string' },
          },
          required: ['env'],
        },
      },
    }, async (req, res) => {
      const { env: envId, returnPath = '/' } = req.query
      if (!returnPath.startsWith('/')) {
        res.statusCode = 400
        return { error: 'returnPath must be a relative path' }
      }
      const activeTunnelEntry = await activeTunnelStore.get(envId)
      if (!activeTunnelEntry) {
        res.statusCode = 404
        return { error: 'unknown envId' }
      }
      const { value: activeTunnel } = activeTunnelEntry
      const session = sessionStore(req.raw, res.raw, activeTunnel.publicKeyThumbprint)
      if (!session.user) {
        const auth = authFactory(activeTunnel)
        const result = await auth(req.raw)
        if (!result.isAuthenticated) {
          if (saasBaseUrl) {
            return await res.header('Access-Control-Allow-Origin', saasBaseUrl)
              .redirect(`${saasBaseUrl}/api/auth/login?redirectTo=${encodeURIComponent(buildLoginUrl({ baseUrl, env: envId, returnPath }))}`)
          }
          res.statusCode = 401
          return { error: 'Unauthorized' }
        }
        session.set(result.claims)
        session.save()
      }
      return await res.redirect(new URL(returnPath, editUrl(baseUrl, { hostname: `${envId}.${baseUrl.hostname}` })).toString())
    })

  return a
}
