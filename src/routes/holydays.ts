import {chain, Either, fromPromise, right} from "@sweet-monads/either"
import * as cheerio from "cheerio"
import type {FastifyInstance} from "fastify"

const MONTHS: readonly string[] = [
  "yanvar",
  "fevral",
  "mart",
  "aprel",
  "may",
  "iyun",
  "iyul",
  "avgust",
  "sentyabr",
  "oktyabr",
  "noyabr",
  "dekabr",
]

type HolydaysData = {
  readonly holydays: readonly string[]
  readonly events: readonly string[]
  readonly nameDays: readonly string[]
}

async function fetchHolydays(
  targetDate: Date,
): Promise<Either<unknown, HolydaysData>> {
  const monthName = MONTHS[targetDate.getMonth()]

  return fromPromise(
    fetch(
      `http://webcache.googleusercontent.com/search?q=cache:https://kakoysegodnyaprazdnik.ru/baza/${monthName}/${targetDate.getDate()}`,
      {
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;",
        },
      },
    ).then((res) => res.text()),
  ).then(
    chain(async (documentRawHtml) => {
      const select = cheerio.load(documentRawHtml)

      const holydays = select.extract({
        items: [
          {
            selector: `[itemprop="acceptedAnswer"] [itemprop="text"], [itemprop="suggestedAnswer"] [itemprop="text"]`,
            value: "innerText",
          },
        ],
      })

      const nameDays = holydays.items
        .find((d) => d.includes("Именины у"))
        ?.split(", ")

      const events = select.extract({
        items: [
          {
            selector: ".event_block .event",
            value: "innerText",
          },
        ],
      })

      return right({
        holydays: holydays.items.filter((d) => !d.includes("Именины у")),
        events: events.items.map(i => i.replace("• ", "")),
        nameDays: nameDays ?? [],
      } as HolydaysData)
    }),
  )
}

function createMessageContentFromHolydaysData(
  data: HolydaysData,
  targetDate: Date,
): string {
  return [
    `## Праздники ${targetDate.toLocaleDateString("ru-RU", {
      dateStyle: "medium",
    })}`,
    data.holydays.map((i) => `- ${i}`).join("\n"),
    "### Именины",
    data.nameDays.map((d) => `- ${d}`).join("\n"),
    "### События в истории",
    data.events.map((i) => `- ${i}`).join("\n"),
    `Праздники взяты с сайта: kakoysegodnyaprazdnik.ru`,
  ].join("\n")
}

function createRedisKey(date: Date): string {
  return date.toISOString().split("T")[0] as string
}

function createTimeReplyMessage(text: string) {
  return {
    response_type: "in_channel",
    text,
  }
}

enum ErrorCode {
  RedisRead = "REDIS_READ_ERROR",
  SiteParse = "SITE_PARSE_ERROR",
}

const HolydaysBodySchema = {
  type: "object",
  properties: {
    text: {type: "string"},
  },
}

const HolydaysResponseSchema = {
  200: {
    type: "object",
    required: ["response_type", "text"],
    properties: {
      response_type: {type: "string"},
      text: {type: "string"},
    },
  },
}

const HolydaysHeadersSchema = {
  type: "object",
  properties: {
    Authorization: {type: "string"},
  },
  additionalProperties: false,
}

export default async function (fastify: FastifyInstance) {
  // const redisClient = fastify.redis
  fastify.post(
    "/holydays-time-command-webhook",
    {
      schema: {
        body: HolydaysBodySchema,
        response: HolydaysResponseSchema,
        headers: HolydaysHeadersSchema,
      },
    },
    async (request) => {
      const {NODE_ENV, TIME_TOKEN} = fastify.config

      if (NODE_ENV === "production") {
        const requestToken = request.headers.authorization?.replace(
          "Token ",
          "",
        )

        if (requestToken !== TIME_TOKEN) {
          request.log.warn("Ошибка авторизации")
          return createTimeReplyMessage("Ошибка авторизации")
        }
      }

      const today = new Date()
      /*const cacheKey = createRedisKey(today)
      const isNoCache = Boolean(
        (
          request.body as {
            text?: string
          }
        ).text?.includes("nocache"),
      )
      const cachedData = await redisClient.get(cacheKey)

      if (!isNoCache && cachedData) {
        const result = fromTry(() => JSON.parse(cachedData) as HolydaysData)

        if (result.isLeft()) {
          request.log.error("Не удалось считать данные из Redis", result.value)
          return createTimeReplyMessage(
            `Не получилось запросить праздники, попробуйте позже. Код ошибки: ${ErrorCode.RedisRead}`,
          )
        }

        request.log.info("Данные из Redis успешно считаны")
        return createTimeReplyMessage(
          createMessageContentFromHolydaysData(result.value, today),
        )
      }*/

      const requestResult = await fetchHolydays(today)

      if (requestResult.isLeft()) {
        request.log.error(
          "Не удалось получить данные с сайта",
          requestResult.value,
        )
        return createTimeReplyMessage(
          `Не получилось запросить праздники, попробуйте позже. Код ошибки: ${ErrorCode.SiteParse}`,
        )
      }

      /*redisClient.set(
        cacheKey,
        JSON.stringify(requestResult.value),
        "EX",
        172_800,
      )*/

      request.log.info("Данные успешно запрошены")
      return createTimeReplyMessage(
        createMessageContentFromHolydaysData(requestResult.value, today),
      )
    },
  )
}
