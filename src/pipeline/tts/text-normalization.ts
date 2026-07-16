import { applyTtsSpokenFallbacks } from "../tts-pronunciation";

const CHINESE_DIGITS: Record<string, string> = {
  "0": "零", "1": "一", "2": "二", "3": "三", "4": "四",
  "5": "五", "6": "六", "7": "七", "8": "八", "9": "九",
};

function pronounceDigits(value: string) {
  return [...value].map((digit) => CHINESE_DIGITS[digit] ?? digit).join("");
}

function chineseSection(value: number) {
  const units = ["千", "百", "十", ""];
  const divisors = [1000, 100, 10, 1];
  let result = "";
  let pendingZero = false;
  for (let index = 0; index < divisors.length; index += 1) {
    const divisor = divisors[index];
    const digit = Math.floor(value / divisor) % 10;
    const remainder = value % divisor;
    if (digit === 0) {
      if (result && remainder > 0) pendingZero = true;
      continue;
    }
    if (pendingZero) result += "零";
    const omitLeadingOne = digit === 1 && divisor === 10 && !result;
    result += `${omitLeadingOne ? "" : CHINESE_DIGITS[String(digit)]}${units[index]}`;
    pendingZero = false;
  }
  return result || "零";
}

function integerToChinese(value: string): string {
  const normalized = value.replace(/^0+(?=\d)/, "");
  const numeric = Number(normalized);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return pronounceDigits(normalized);
  if (numeric < 10000) return chineseSection(numeric);
  if (numeric < 100000000) {
    const high = Math.floor(numeric / 10000);
    const low = numeric % 10000;
    return `${integerToChinese(String(high))}万${low ? `${low < 1000 ? "零" : ""}${chineseSection(low)}` : ""}`;
  }
  if (numeric < 1000000000000) {
    const high = Math.floor(numeric / 100000000);
    const low = numeric % 100000000;
    return `${integerToChinese(String(high))}亿${low ? `${low < 10000000 ? "零" : ""}${integerToChinese(String(low))}` : ""}`;
  }
  return pronounceDigits(normalized);
}

function numberToChinese(value: string) {
  const [whole, fraction] = value.split(".");
  const spokenWhole = integerToChinese(whole || "0");
  return fraction ? `${spokenWhole}点${pronounceDigits(fraction)}` : spokenWhole;
}

export function removeLoneSurrogates(text: string) {
  let clean = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        clean += text[index] + text[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    clean += text[index];
  }
  return clean;
}

export function prepareF5SynthesisText(text: string) {
  const trimmed = applyTtsSpokenFallbacks(removeLoneSurrogates(text)).trim();
  const startsWithLatin = /^[A-Za-z0-9]/.test(trimmed);
  const pronounceable = trimmed
    .replace(/^曝/u, "爆料称：")
    .replace(/重置/g, "重新设置")
    .replace(/豆包和千问/g, "豆包，和千问，")
    .replace(/DeepSeek/gi, "深度求索")
    .replace(/MoneyPrinterTurbo/gi, "Money Printer Turbo")
    .replace(/awesome-llm-apps/gi, "这个项目")
    .replace(/\bRAG\b/gi, "检索增强生成")
    .replace(/\bAI\b/g, "人工智能")
    .replace(/K2[.]7 Code HighSpeed/gi, "K二点七代码高速版")
    .replace(/K2[.]7 Code/gi, "K二点七代码")
    .replace(/Kimi Code CLI/gi, "Kimi代码命令行工具")
    .replace(/Kimi Code/gi, "Kimi代码")
    .replace(/Coding Plan/gi, "编程套餐")
    .replace(/Allegretto/gi, "阿莱格雷托")
    .replace(/GitNexus/gi, "吉特奈克瑟斯")
    .replace(/AI[ -]?Berkshire/gi, "AI 伯克希尔")
    .replace(/OmniRoute/gi, "奥姆尼路由")
    .replace(/Superpowers/gi, "超级能力")
    .replace(/next-ai-draw-io/gi, "奈克斯特，人工智能绘图工具，")
    .replace(/Next[.]js/gi, "Next JS")
    .replace(/draw[.]io/gi, "Draw IO")
    .replace(/ChatGPT/gi, "聊天 GPT，")
    .replace(/Codex/gi, "Codex，")
    .replace(/OpenAI/gi, "欧盆艾，")
    .replace(/Prompt/gi, "提示词")
    .replace(/Agent/gi, "智能体")
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(/(\d+(?:[.]\d+)?)\s*%/g, (_, value: string) => `百分之${numberToChinese(value)}`)
    .replace(/(\d+)\+(?=\D|$)/g, (_, value: string) => `${numberToChinese(value)}以上`)
    .replace(/(?<!\d)(\d{4})(?=年)/g, (_, value: string) => pronounceDigits(value))
    .replace(/\d+(?:[.]\d+)?/g, (value) => numberToChinese(value));
  if (/\d/.test(pronounceable)) {
    throw new Error(`TTS number normalization left Arabic digits: ${pronounceable.match(/\d+/g)?.join(", ")}`);
  }
  return /^[。！？!?]/.test(pronounceable) ? pronounceable : `。${pronounceable}`;
}
