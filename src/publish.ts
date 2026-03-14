import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FormatResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'output');

async function saveObsidian(content: string, date: string): Promise<string> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.log('[publish] OBSIDIAN_VAULT_PATH 未配置，跳过 Obsidian 保存');
    return '';
  }

  const filename = `${date}-daily-news.md`;
  const filepath = join(vaultPath, filename);
  await writeFile(filepath, content, 'utf-8');
  console.log(`[publish] Obsidian 文件已保存: ${filepath}`);
  return filepath;
}

async function saveSubstackFile(content: string, date: string): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const filename = `${date}-substack.html`;
  const filepath = join(OUTPUT_DIR, filename);

  // Wrap in a minimal HTML document for easy copy-paste
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>AI 日刊 · ${date}</title>
</head>
<body>
${content}
</body>
</html>`;

  await writeFile(filepath, html, 'utf-8');
  return filepath;
}

function printSubstackInstructions(filepath: string): void {
  const separator = '─'.repeat(60);
  console.log(`\n${separator}`);
  console.log('📮  Substack 发布步骤');
  console.log(separator);
  console.log(`\n文件已保存至：${filepath}\n`);
  console.log('方法一：直接复制 HTML（推荐）');
  console.log('  1. 用浏览器打开上方 HTML 文件');
  console.log('  2. 全选（Cmd+A）并复制（Cmd+C）');
  console.log('  3. 打开 Substack 编辑器，粘贴（Cmd+V）');
  console.log('  4. 调整标题与副标题后发布\n');
  console.log('方法二：手动录入');
  console.log('  1. 登录 https://substack.com/publish/post/new');
  console.log('  2. 参考 HTML 文件内容，逐条粘贴标题和摘要');
  console.log('  3. 确认无误后点击发布\n');
  console.log(separator);
}

export async function publish(result: FormatResult): Promise<void> {
  const { obsidian, substack, date } = result;

  await saveObsidian(obsidian, date);
  const substackFile = await saveSubstackFile(substack, date);
  console.log(`[publish] Substack 草稿已保存: ${substackFile}`);

  printSubstackInstructions(substackFile);
}
