import {FastifyInstance} from "fastify"

export default async function (fastify: FastifyInstance) {
  fastify.get("/health", () => {
    return "All is Ok."
  })
}
