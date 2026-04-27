/**
 * Tiny single-line progress reporter.
 *
 * In a TTY:  prints to stdout, overwriting the same line via \r + clearLine.
 * Outside TTY (CI, pipes): prints discrete lines so tail/grep stay sane.
 *
 * Designed for "current/total + short message" style updates. Not a
 * spinner — keep dependencies minimal.
 */

const isTTY = (): boolean => Boolean(process.stdout.isTTY);

export class Progress {
  private lastLineLength = 0;
  private active = false;

  /** Write or update the progress line. */
  update(current: number, total: number | undefined, message: string): void {
    const totalText = total !== undefined && total > 0 ? `/${total}` : '';
    const pct = total && total > 0 ? ` (${Math.floor((current / total) * 100)}%)` : '';
    const line = `  [${current}${totalText}]${pct} ${truncate(message, 70)}`;

    if (isTTY()) {
      this.clearLine();
      process.stdout.write(line);
      this.lastLineLength = line.length;
      this.active = true;
    } else {
      // Non-TTY: drop very chatty intermediate updates, keep first/last meaningful ones
      console.log(line);
    }
  }

  /** Print a message above the progress line (e.g. warnings). */
  log(message: string): void {
    if (isTTY() && this.active) {
      this.clearLine();
      console.log(message);
      this.active = false;
      this.lastLineLength = 0;
    } else {
      console.log(message);
    }
  }

  /** Finish the line and move to the next. */
  finish(): void {
    if (isTTY() && this.active) {
      process.stdout.write('\n');
    }
    this.active = false;
    this.lastLineLength = 0;
  }

  private clearLine(): void {
    if (this.lastLineLength === 0) return;
    process.stdout.write(`\r${' '.repeat(this.lastLineLength)}\r`);
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}
