/** Python 任务：`python3 verify.py`，只用标准库断言；无 python3 时整组跳过。 */
import type { EvalTask } from "../task.js";

export const PY_TASKS: EvalTask[] = [
  {
    id: "py-implement-slugify",
    title: "实现 slugify 使断言通过",
    lang: "py",
    kind: "implement",
    prompt:
      "slug.py 里的 slugify(s) 还没实现。规则：小写、连续非字母数字折叠为单个连字符、去首尾连字符。" +
      "改完后 `python3 verify.py` 应当通过。",
    requires: ["python3"],
    files: {
      "slug.py": "def slugify(s):\n    # TODO: 实现\n    raise NotImplementedError\n",
      "verify.py":
        "from slug import slugify\n" +
        "assert slugify('Hello World') == 'hello-world', slugify('Hello World')\n" +
        "assert slugify('  A_B c ') == 'a-b-c', slugify('  A_B c ')\n" +
        "assert slugify('Already-Fine') == 'already-fine'\n" +
        "print('ok')\n",
    },
    verify: { cmd: "python3", args: ["verify.py"] },
    solution: {
      "slug.py":
        "import re\n\n" +
        "def slugify(s):\n" +
        "    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')\n",
    },
  },
  {
    id: "py-fix-mutable-default",
    title: "修复可变默认参数导致的状态串扰",
    lang: "py",
    kind: "fix",
    prompt:
      "collect.py 的 append_item 在多次调用之间发生了状态串扰（第二次调用会带上第一次的数据）。" +
      "请修复这个经典缺陷，使 `python3 verify.py` 通过。",
    requires: ["python3"],
    files: {
      "collect.py":
        "def append_item(item, bucket=[]):\n" + "    bucket.append(item)\n" + "    return bucket\n",
      "verify.py":
        "from collect import append_item\n" +
        "assert append_item(1) == [1], append_item(1)\n" +
        "assert append_item(2) == [2], 'bucket 在两次调用间不应共享'\n" +
        "shared = []\n" +
        "assert append_item(3, shared) is shared and shared == [3]\n" +
        "print('ok')\n",
    },
    verify: { cmd: "python3", args: ["verify.py"] },
    solution: {
      "collect.py":
        "def append_item(item, bucket=None):\n" +
        "    if bucket is None:\n" +
        "        bucket = []\n" +
        "    bucket.append(item)\n" +
        "    return bucket\n",
    },
  },
  {
    id: "py-debug-window-sum",
    title: "调试：滑动窗口最大和漏掉最后一个窗口",
    lang: "py",
    kind: "debug",
    prompt:
      "window.py 的 max_window_sum(xs, k) 在某些输入下结果偏小。先运行 `python3 verify.py` 复现失败，" +
      "再定位并修复 window.py（不要改 verify.py）。",
    requires: ["python3"],
    files: {
      "window.py":
        "def max_window_sum(xs, k):\n" +
        "    best = None\n" +
        "    for i in range(len(xs) - k):\n" +
        "        s = sum(xs[i:i + k])\n" +
        "        if best is None or s > best:\n" +
        "            best = s\n" +
        "    return best\n",
      "verify.py":
        "from window import max_window_sum\n" +
        "assert max_window_sum([1, 2, 3], 2) == 5, max_window_sum([1, 2, 3], 2)\n" +
        "assert max_window_sum([5, 1, 1], 2) == 6\n" +
        "assert max_window_sum([1, 2, 9], 3) == 12, '整个数组本身就是唯一窗口'\n" +
        "assert max_window_sum([4], 1) == 4\n" +
        "print('ok')\n",
    },
    verify: { cmd: "python3", args: ["verify.py"] },
    solution: {
      "window.py":
        "def max_window_sum(xs, k):\n" +
        "    best = None\n" +
        "    for i in range(len(xs) - k + 1):\n" +
        "        s = sum(xs[i:i + k])\n" +
        "        if best is None or s > best:\n" +
        "            best = s\n" +
        "    return best\n",
    },
  },
  {
    id: "py-refactor-split",
    title: "重构：把格式化函数拆到独立模块",
    lang: "py",
    kind: "refactor",
    prompt:
      "report.py 里混着数据处理 parse_csv 和展示 format_row 两类职责。请新建 fmt.py，把 format_row " +
      "移过去；report.py 改为 `from fmt import format_row`（自身不再定义它），对外行为不变。" +
      "改完 `python3 verify.py` 应当通过（校验会检查行为与源码结构）。",
    requires: ["python3"],
    files: {
      "report.py":
        "def parse_csv(line):\n" +
        "    return [c.strip() for c in line.split(',')]\n\n" +
        "def format_row(cells):\n" +
        "    return ' | '.join(cells)\n\n" +
        "def render(line):\n" +
        "    return format_row(parse_csv(line))\n",
      "verify.py":
        "from report import render, parse_csv\n" +
        "from fmt import format_row\n" +
        "assert render('a, b ,c') == 'a | b | c', render('a, b ,c')\n" +
        "assert parse_csv(' x ,y') == ['x', 'y']\n" +
        "assert format_row(['1', '2']) == '1 | 2'\n" +
        "src = open('report.py', encoding='utf-8').read()\n" +
        "assert 'from fmt import' in src, 'report.py 应从 fmt 导入 format_row'\n" +
        "assert 'def format_row' not in src, 'report.py 不应再定义 format_row'\n" +
        "print('ok')\n",
    },
    verify: { cmd: "python3", args: ["verify.py"] },
    solution: {
      "fmt.py": "def format_row(cells):\n    return ' | '.join(cells)\n",
      "report.py":
        "from fmt import format_row\n\n" +
        "def parse_csv(line):\n" +
        "    return [c.strip() for c in line.split(',')]\n\n" +
        "def render(line):\n" +
        "    return format_row(parse_csv(line))\n",
    },
  },
];
