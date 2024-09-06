import {chain, Either, fromPromise, fromTry, right} from "@sweet-monads/either"
import * as cheerio from "cheerio"
import {CronJob} from "cron"
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

type HolidaysData = {
  readonly holidays: readonly string[]
  readonly events: readonly string[]
  readonly nameDays: readonly string[]
}

async function fetchHolidays(
  targetDate: Date,
): Promise<Either<unknown, HolidaysData>> {
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

      const holidays = select.extract({
        items: [
          {
            selector: `[itemprop="acceptedAnswer"] [itemprop="text"], [itemprop="suggestedAnswer"] [itemprop="text"]`,
            value: "innerText",
          },
        ],
      })

      const nameDays = holidays.items
        .find((d) => d.includes("Именины у"))
        ?.replace("Именины у", "")
        .split(", ")

      const events = select.extract({
        items: [
          {
            selector: ".event_block .event",
            value: "innerText",
          },
        ],
      })

      return right({
        holidays: holidays.items.filter((d) => !d.includes("Именины у")),
        events: events.items.map(i => i.replace("• ", "")),
        nameDays: nameDays ?? [],
      } as HolidaysData)
    }),
  )
}

function createMessageContentFromHolidaysData(
  data: HolidaysData,
  targetDate: Date,
): string {
  return [
    `## Праздники ${targetDate.toLocaleDateString("ru-RU", {
      dateStyle: "medium",
    })}`,
    data.holidays.map((i) => `- ${i}`).join("\n"),
    "### Именины",
    data.nameDays.map((d) => `- ${d}`).join("\n"),
    "### События в истории",
    data.events.map((i) => `- ${i}`).join("\n"),
    `Праздники взяты с сайта: [kakoysegodnyaprazdnik.ru](kakoysegodnyaprazdnik.ru)`,
  ].join("\n")
}

function createCacheKey(date: Date): string {
  return date.toISOString().split("T")[0] as string
}

function createTimeReplyMessage(text: string) {
  return {
    icon_url: "https://storage.yandexcloud.net/mephistorine-pocketbase-test/TwemojiPartyPopper%201%20(1).png",
    response_type: "in_channel",
    text,
  }
}

enum ErrorCode {
  RedisRead = "REDIS_READ_ERROR",
  SiteParse = "SITE_PARSE_ERROR",
}

const HolidaysBodySchema = {
  type: "object",
  properties: {
    text: {type: "string"},
  },
}

const HolidaysResponseSchema = {
  200: {
    type: "object",
    required: ["response_type", "text"],
    properties: {
      response_type: {type: "string"},
      text: {type: "string"},
    },
  },
}

const HolidaysHeadersSchema = {
  type: "object",
  properties: {
    Authorization: {type: "string"},
  },
  additionalProperties: false,
}

export default async function (fastify: FastifyInstance) {
  const redisClient = fastify.redis

  const job = CronJob.from({
    // Every night at 00:00
    cronTime: "0 0 * * *",
    timeZone: "Europe/London",
    start: true,
    onTick: async () => {
      const now = new Date()
      const holidays = await fetchHolidays(now)

      if (holidays.isLeft()) {
        fastify.log.error("[Cron] Не удалось закешировать праздники", holidays.value)
        return
      }

      const cacheKey = createCacheKey(now)

      redisClient.set(
        cacheKey,
        JSON.stringify(holidays.value),
        "EX",
        172_800,
      )

      fastify.log.info(`[Cron] Праздники успешно закешированы по пути ${cacheKey}`)
    }
  })

  job.start()

  fastify.route({
    method: "POST",
    url: "/holidays-time-command-webhook",
    schema: {
      body: HolidaysBodySchema,
      response: HolidaysResponseSchema,
      headers: HolidaysHeadersSchema,
    },
    handler: async (request) => {
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
      fastify.log.info(`Получаем праздники для ${today.toISOString()}`)
      const cacheKey = createCacheKey(today)
      const isNoCache = Boolean(
        (
          request.body as {
            text?: string
          }
        ).text?.includes("nocache"),
      )
      const cachedData = await redisClient.get(cacheKey)

      if (!isNoCache && cachedData) {
        const result = fromTry(() => JSON.parse(cachedData) as HolidaysData)

        if (result.isLeft()) {
          request.log.error("Не удалось считать данные из Redis", result.value)
          return createTimeReplyMessage(
            `Не получилось запросить праздники, попробуйте позже. Код ошибки: ${ErrorCode.RedisRead}`,
          )
        }

        request.log.info("Данные из Redis успешно считаны")
        return createTimeReplyMessage(
          createMessageContentFromHolidaysData(result.value, today),
        )
      }

      const requestResult = await fetchHolidays(today)

      if (requestResult.isLeft()) {
        request.log.error(
          "Не удалось получить данные с сайта",
          requestResult.value,
        )
        return createTimeReplyMessage(
          `Не получилось запросить праздники, попробуйте позже. Код ошибки: ${ErrorCode.SiteParse}`,
        )
      }

      redisClient.set(
        cacheKey,
        JSON.stringify(requestResult.value),
        "EX",
        172_800,
      )

      request.log.info("Данные успешно запрошены")
      return createTimeReplyMessage(
        createMessageContentFromHolidaysData(requestResult.value, today),
      )
    }
  })
}
