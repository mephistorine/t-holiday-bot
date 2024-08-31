import fastifyEnv from "@fastify/env"
import fastifyFormbody from "@fastify/formbody"
import fastifyRedis from "@fastify/redis"
import fastifySensible from "@fastify/sensible"
import createFastify from "fastify"

import holydaysRouteHandler from "./routes/holydays"
import healthRouteHandler from "./routes/health"

const port = process.env.PORT ? Number(process.env.PORT) : 3000
const host = process.env.HOST ?? "localhost"

const EnvSchema = {
  type: "object",
  required: [],
  properties: {
    PORT: {
      type: "string",
      default: 3000,
    },
    HOST: {
      type: "string",
      default: "localhost",
    },
    REDIS_URL: {
      type: "string",
    },
    TIME_TOKEN: {
      type: "string",
    },
    NODE_ENV: {
      type: "string",
      default: "development",
    },
  },
}

declare module "fastify" {
  interface FastifyInstance {
    config: {
      PORT: string
      HOST: string
      REDIS_URL: string
      TIME_TOKEN: string
      NODE_ENV: string
    }
  }
}

const fastify = createFastify({
  logger: {
    enabled: true,
    file: "./app.log",
  },
})

fastify
  .register(fastifyRedis, {
    url: process.env.REDIS_URL,
  })
  .register(fastifyEnv, {schema: EnvSchema})
  .register(fastifyFormbody)
  .register(fastifySensible)
  .register(holydaysRouteHandler)
  .register(healthRouteHandler)

fastify.listen({port, host}, (error) => {
  if (error) {
    fastify.log.error(error)
    process.exit(1)
  } else {
    console.log(`[ ready ] http://${host}:${port}`)
  }
})
