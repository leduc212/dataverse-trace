// Tolerant parser for the text in plugintracelog.exceptiondetails and similar .NET exception dumps.
// Never throws: unknown shapes fall back to the raw text.

export interface StackFrame {
  text: string;
  /** e.g. `Harbor.Plugins.PolicyPostCreate.Execute`. */
  method?: string;
  file?: string;
  line?: number;
  /** True for frames outside the user's code (System.*, Microsoft.Xrm.*, Microsoft.Crm.*, …). */
  framework: boolean;
}

export interface ParsedException {
  type?: string;
  message: string;
  errorCode?: string;
  frames: StackFrame[];
  inner: ParsedException[];
  raw: string;
}

const FRAMEWORK_PREFIXES = [
  'System.',
  'Microsoft.Xrm.',
  'Microsoft.Crm.',
  'Microsoft.PowerPlatform.',
  'Microsoft.Dynamics.',
  'Microsoft.CSharp.',
  'Microsoft.Cds.',
  'Castle.',
  'Newtonsoft.',
];

const FRAME = /^\s*at\s+(.+?)(?:\s+in\s+(.+):line\s+(\d+))?\s*$/;

function parseFrame(line: string): StackFrame | null {
  const m = FRAME.exec(line);
  if (!m) return null;
  const signature = m[1]!;
  const method = signature.replace(/\(.*$/, '').trim();
  const frame: StackFrame = {
    text: line.trim(),
    method,
    framework: FRAMEWORK_PREFIXES.some((p) => method.startsWith(p)),
  };
  if (m[2]) frame.file = m[2];
  if (m[3]) frame.line = Number(m[3]);
  return frame;
}

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]!.trim()) : undefined;
};

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Splits "Type: message" when the prefix looks like a .NET type name. */
function splitTypeAndMessage(line: string): { type?: string; message: string } {
  const m = /^([A-Za-z_][\w.`[\]+,]*(?:Exception|Fault|Error)[\w`[\].,+]*)\s*:\s*([\s\S]*)$/.exec(line.trim());
  return m ? { type: m[1]!, message: m[2]!.trim() } : { message: line.trim() };
}

const END_OF_INNER = /^\s*---\s*End of inner exception stack trace\s*---\s*$/;

/**
 * .NET `ToString()` output: "A: a ---> B: b ---> C: c", then C's frames, an "End of inner exception
 * stack trace" marker, B's frames, another marker, and A's frames. So every frame sits after the
 * deepest head, and the markers split them from the innermost exception outward.
 */
function parseDotNetDump(text: string): ParsedException {
  const parts = text.split(/\s--->\s/);
  const heads: Array<{ type?: string; message: string }> = [];
  const segments: StackFrame[][] = [[]];
  for (const part of parts) {
    // The head (type and message) runs until the first stack frame or marker.
    const messageLines: string[] = [];
    let inFrames = false;
    for (const line of part.split('\n')) {
      const frame = parseFrame(line);
      if (frame) {
        inFrames = true;
        segments[segments.length - 1]!.push(frame);
      } else if (END_OF_INNER.test(line)) {
        inFrames = true;
        segments.push([]);
      } else if (!inFrames && line.trim()) {
        messageLines.push(line.trim());
      }
    }
    heads.push(splitTypeAndMessage(messageLines.join('\n')));
  }

  // segments[0] belongs to the deepest exception, the last segment to the outermost.
  let result: ParsedException | undefined;
  for (let depth = heads.length - 1; depth >= 0; depth--) {
    const head = heads[depth]!;
    const segmentIndex = heads.length - 1 - depth;
    const node: ParsedException = {
      message: head.message,
      frames: segments[segmentIndex] ?? [],
      inner: result ? [result] : [],
      raw: depth === 0 ? text : parts.slice(depth).join(' ---> '),
    };
    if (head.type) node.type = head.type;
    result = node;
  }
  return result!;
}

/**
 * Parses exception text from a trace log. Handles the platform's "Unhandled exception / Exception
 * type / Message / Detail: <OrganizationServiceFault…>" dump and plain .NET `ToString()` output.
 */
export function parseException(raw: string | null | undefined): ParsedException | null {
  if (!raw || !raw.trim()) return null;
  const text = raw.replace(/\r\n/g, '\n');

  const typeLine = /^\s*Exception type:\s*(.+)$/m.exec(text);
  const messageLine = /^\s*Message:\s*([\s\S]*?)(?:\n\s*Detail:|\n\s*at\s|$)/m.exec(text);
  if (typeLine || messageLine) {
    const fault = /<OrganizationServiceFault[\s\S]*<\/OrganizationServiceFault>/.exec(text)?.[0];
    const frames = text
      .split('\n')
      .map(parseFrame)
      .filter((f): f is StackFrame => f !== null);
    const parsed: ParsedException = {
      message: (fault && tag(fault, 'Message')) || messageLine?.[1]?.trim() || text.trim().split('\n')[0]!,
      frames,
      inner: [],
      raw,
    };
    if (typeLine) parsed.type = typeLine[1]!.trim();
    const code = fault ? tag(fault, 'ErrorCode') : undefined;
    if (code) parsed.errorCode = code;
    const innerFault = fault ? /<InnerFault>([\s\S]*)<\/InnerFault>/.exec(fault)?.[1] : undefined;
    const innerMessage = innerFault ? tag(innerFault, 'Message') : undefined;
    if (innerMessage && innerMessage !== parsed.message) {
      parsed.inner.push({ message: innerMessage, frames: [], inner: [], raw: innerFault! });
    }
    return parsed;
  }
  return parseDotNetDump(text);
}

/** One-line summary for grids and span labels. */
export function summarizeException(raw: string | null | undefined, maxLength = 200): string | null {
  const parsed = parseException(raw);
  if (!parsed) return null;
  const firstLine = parsed.message.split('\n')[0] ?? '';
  const shortType = parsed.type?.replace(/`\d.*$/, '').split('.').pop();
  const text = shortType && !firstLine.startsWith(shortType) ? `${shortType}: ${firstLine}` : firstLine;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
