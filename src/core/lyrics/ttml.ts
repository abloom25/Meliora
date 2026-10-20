import type { LyricAgent, LyricLine, LyricWord } from '../types'
import { MIN_WORD_DURATION, joinWords } from './lyrics'

// Apple Music 使用的 TTML 逐词歌词格式解析器。
//
// 结构固定为 <p> 一行、内嵌 <span begin end> 一个音节,附加信息挂在带 ttm:role 的 span 上:
//   x-translation 翻译 / x-roman 罗马音 / x-bg 背景和声(内部再嵌一层音节 span)。
// 对唱由 <p ttm:agent> 区分声部。
//
// 这里手写标签扫描而不用 DOMParser:保持 §3.7 要求的纯函数、无 DOM 依赖,
// 同时避开 XML 命名空间前缀在不同实现下解析结果不一致的问题。TTML 由歌词工具生成,
// 结构规整,不需要通用 XML 解析器的容错能力。

interface TtmlTag {
  name: string
  attributes: Record<string, string>
  selfClosing: boolean
  /** 标签在源串中结束的位置(">" 之后) */
  end: number
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * TTML 时间表达式 → 秒。支持 `hh:mm:ss.fff` / `mm:ss.fff` / `12.5s` / `340ms` / 纯秒数。
 * 无法识别时返回 null,由调用方决定丢弃还是回退。
 */
export function parseTtmlTime(value: string | undefined): number | null {
  if (!value) return null
  const raw = value.trim()
  if (!raw) return null

  const clock = raw.match(/^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/)
  if (clock) {
    const hours = clock[1] ? Number(clock[1]) : 0
    return hours * 3600 + Number(clock[2]) * 60 + Number(clock[3])
  }

  const offset = raw.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)?$/)
  if (offset) {
    const amount = Number(offset[1])
    switch (offset[2]) {
      case 'h':
        return amount * 3600
      case 'm':
        return amount * 60
      case 'ms':
        return amount / 1000
      case undefined:
      case 's':
        return amount
      default:
        // 帧/刻度需要 tick rate 才能换算,当前歌词源不使用,直接放弃
        return null
    }
  }

  return null
}

// 从 "<" 处读出一个完整标签。attribute 值同时接受单引号与双引号
function readTag(source: string, start: number): TtmlTag | null {
  if (source[start] !== '<') return null
  const nameMatch = /^<\/?([A-Za-z_][\w.:-]*)/.exec(source.slice(start))
  if (!nameMatch) return null

  let index = start + nameMatch[0].length
  const attributes: Record<string, string> = {}

  while (index < source.length) {
    const char = source[index]
    if (char === '>') return { name: nameMatch[1], attributes, selfClosing: false, end: index + 1 }
    if (char === '/' && source[index + 1] === '>') {
      return { name: nameMatch[1], attributes, selfClosing: true, end: index + 2 }
    }
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    const attribute = /^([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(index))
    if (!attribute) {
      index += 1
      continue
    }
    attributes[attribute[1]] = decodeXmlEntities(attribute[3] ?? attribute[4] ?? '')
    index += attribute[0].length
  }

  return null
}

/** 去掉命名空间前缀:ttm:role / itunes:key 在不同导出工具里前缀名不固定 */
function attribute(attributes: Record<string, string>, localName: string): string | undefined {
  const direct = attributes[localName]
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(attributes)) {
    if (key.slice(key.indexOf(':') + 1) === localName) return value
  }
  return undefined
}

interface SpanNode {
  role?: string
  begin: number | null
  end: number | null
  text: string
  children: SpanNode[]
}

// 扫描一段 XML 内容,返回其中的顶层 span 节点与散落的纯文本
function scanSpans(source: string, from: number, to: number): { spans: SpanNode[]; text: string } {
  const spans: SpanNode[] = []
  let text = ''
  let index = from

  while (index < to) {
    const next = source.indexOf('<', index)
    if (next < 0 || next >= to) {
      text += decodeXmlEntities(source.slice(index, to))
      break
    }
    const between = decodeXmlEntities(source.slice(index, next))
    text += between
    // span 之间的纯空白文本节点是词间空格(英文 TTML 常见写法),
    // 归给前一个音节,否则拼回去的整行会粘成一个词
    if (between && !between.trim() && spans.length) {
      const previous = spans[spans.length - 1]
      if (previous.begin !== null) previous.text += ' '
    }

    const tag = readTag(source, next)
    if (!tag || tag.end > to) {
      // 无法识别的 "<" 当作普通字符,避免整段内容被吞掉
      text += source[next]
      index = next + 1
      continue
    }
    if (tag.name !== 'span') {
      index = tag.end
      continue
    }

    const node: SpanNode = {
      role: attribute(tag.attributes, 'role'),
      begin: parseTtmlTime(attribute(tag.attributes, 'begin')),
      end: parseTtmlTime(attribute(tag.attributes, 'end')),
      text: '',
      children: [],
    }

    if (tag.selfClosing) {
      spans.push(node)
      index = tag.end
      continue
    }

    const closeAt = findMatchingClose(source, tag.end, to)
    const inner = scanSpans(source, tag.end, closeAt.contentEnd)
    node.text = inner.text
    node.children = inner.spans
    spans.push(node)
    index = closeAt.after
  }

  return { spans, text }
}

// 找到与当前 span 配对的 </span>,跳过所有嵌套的 <span>
function findMatchingClose(
  source: string,
  from: number,
  to: number,
): { contentEnd: number; after: number } {
  let depth = 1
  let index = from

  while (index < to) {
    const next = source.indexOf('<span', index)
    const close = source.indexOf('</span', index)
    if (close < 0 || close >= to) break
    if (next >= 0 && next < close && next < to) {
      const tag = readTag(source, next)
      if (tag && !tag.selfClosing) depth += 1
      index = tag ? tag.end : next + 5
      continue
    }
    depth -= 1
    const closeTag = readTag(source, close)
    const after = closeTag ? closeTag.end : close + 7
    if (depth === 0) return { contentEnd: close, after }
    index = after
  }

  return { contentEnd: to, after: to }
}

function toWords(spans: readonly SpanNode[], lineEnd: number | null): LyricWord[] {
  const timed = spans.filter((span) => span.begin !== null && span.text.trim())
  const words: LyricWord[] = []

  for (let index = 0; index < timed.length; index += 1) {
    const span = timed[index]
    const start = span.begin as number
    const next = timed[index + 1]
    // end 缺省或明显失真时用下一个音节的起点补齐,再不行才用行结束时间
    const stop = span.end ?? next?.begin ?? lineEnd ?? start + MIN_WORD_DURATION
    const word: LyricWord = {
      time: start,
      duration: Math.max(MIN_WORD_DURATION, stop - start),
      text: span.text.trim(),
    }
    if (/\s$/.test(span.text)) word.trailingSpace = true
    words.push(word)
  }

  return words
}

function buildLine(
  spans: readonly SpanNode[],
  fallbackText: string,
  begin: number | null,
  end: number | null,
  agent: LyricAgent,
  background: boolean,
): LyricLine | null {
  const words = toWords(spans, end)
  const translation = spans.find((span) => span.role === 'x-translation')?.text.trim()
  const roman = spans.find((span) => span.role === 'x-roman')?.text.trim()
  const text = words.length ? joinWords(words) : fallbackText.trim()
  if (!text) return null

  const line: LyricLine = { time: begin, text }
  if (words.length) {
    line.words = words
    line.wordSource = 'native'
  }
  if (end !== null) line.endTime = end
  if (translation) line.translation = translation
  if (roman) line.roman = roman
  if (agent !== 'primary') line.agent = agent
  if (background) line.background = true
  return line
}

/**
 * 解析 TTML 逐词歌词。返回按时间排序的行;无法解析出任何带时间的行时返回空数组,
 * 由调用方回退到 LRC。
 */
export function parseTtmlLyrics(source: string): LyricLine[] {
  if (!source.includes('<tt') && !source.includes('<p ')) return []

  const lines: LyricLine[] = []
  const agentOrder: string[] = []
  let index = 0

  while (index < source.length) {
    const open = source.indexOf('<p', index)
    if (open < 0) break
    const tag = readTag(source, open)
    if (!tag || tag.name !== 'p') {
      index = open + 2
      continue
    }
    if (tag.selfClosing) {
      index = tag.end
      continue
    }

    const close = source.indexOf('</p', tag.end)
    const contentEnd = close < 0 ? source.length : close
    const { spans, text } = scanSpans(source, tag.end, contentEnd)

    const agentId = attribute(tag.attributes, 'agent') ?? ''
    if (agentId && !agentOrder.includes(agentId)) agentOrder.push(agentId)
    // 第一个出现的 agent 视为主唱,其余都是对唱声部
    const agent: LyricAgent = !agentId || agentOrder[0] === agentId ? 'primary' : 'secondary'

    const begin = parseTtmlTime(attribute(tag.attributes, 'begin'))
    const end = parseTtmlTime(attribute(tag.attributes, 'end'))
    const mainSpans = spans.filter((span) => span.role !== 'x-bg')
    const main = buildLine(mainSpans, text, begin, end, agent, false)
    if (main) lines.push(main)

    // 背景和声独立成行:它有自己的音节时间轴,合进主行会打乱扫光顺序
    for (const bg of spans.filter((span) => span.role === 'x-bg')) {
      const bgLine = buildLine(
        bg.children,
        bg.text,
        bg.begin ?? main?.time ?? begin,
        bg.end ?? end,
        agent,
        true,
      )
      if (bgLine) lines.push(bgLine)
    }

    index = close < 0 ? source.length : close + 4
  }

  if (!lines.some((line) => line.time !== null)) return []
  return lines.sort((left, right) => (left.time ?? 0) - (right.time ?? 0))
}
