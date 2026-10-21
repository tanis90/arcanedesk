// api-key.js — API key 字符集校验。key 是 ASCII token；粘贴/输入法带入的中文、
// 全角符号或空格会让 Authorization 头编码直接失败（fetch 抛 ByteString 错误，
// 表现为 backendUnavailable），且这样的 key 永远认证不过——保存时拒收，
// 运行时按 authFailed 给出可执行指引。

const PLAUSIBLE_API_KEY = /^[\x21-\x7E]+$/;

/** key 是否只含可打印 ASCII（无空格、无中文/全角字符）。 */
export function isPlausibleApiKey(apiKey) {
  return PLAUSIBLE_API_KEY.test(String(apiKey ?? ""));
}
