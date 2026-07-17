/**
 * Go 任务：`go run .`（package main，main.go 是校验器，跑前会从种子恢复防篡改）；
 * 无 go 工具链时整组跳过。
 */
import type { EvalTask } from "../task.js";

const GO_MOD = "module evaltask\n\ngo 1.21\n";

const CHECK_HELPERS =
  "func check(cond bool, msg string) {\n" +
  "\tif !cond {\n" +
  '\t\tfmt.Println("FAIL:", msg)\n' +
  "\t\tos.Exit(1)\n" +
  "\t}\n" +
  "}\n";

export const GO_TASKS: EvalTask[] = [
  {
    id: "go-implement-reverse",
    title: "实现 rune 安全的字符串反转",
    lang: "go",
    kind: "implement",
    prompt:
      "reverse.go 里的 Reverse(s) 还没实现（注意多字节字符要按 rune 反转）。" +
      "改完后 `go run .` 应当输出 ok。",
    requires: ["go"],
    verifyFiles: ["main.go", "go.mod"],
    files: {
      "go.mod": GO_MOD,
      "reverse.go":
        "package main\n\n" +
        "// Reverse 返回 s 的反转（TODO: 实现，注意多字节字符）。\n" +
        "func Reverse(s string) string {\n" +
        "\treturn s // TODO\n" +
        "}\n",
      "main.go":
        "package main\n\n" +
        'import (\n\t"fmt"\n\t"os"\n)\n\n' +
        CHECK_HELPERS +
        "\nfunc main() {\n" +
        '\tcheck(Reverse("abc") == "cba", `Reverse("abc")`)\n' +
        '\tcheck(Reverse("héllo") == "olléh", "需按 rune 反转")\n' +
        '\tcheck(Reverse("你好") == "好你", `Reverse("你好")`)\n' +
        '\tcheck(Reverse("") == "", "empty")\n' +
        '\tfmt.Println("ok")\n' +
        "}\n",
    },
    verify: { cmd: "go", args: ["run", "."] },
    solution: {
      "reverse.go":
        "package main\n\n" +
        "func Reverse(s string) string {\n" +
        "\trs := []rune(s)\n" +
        "\tfor i, j := 0, len(rs)-1; i < j; i, j = i+1, j-1 {\n" +
        "\t\trs[i], rs[j] = rs[j], rs[i]\n" +
        "\t}\n" +
        "\treturn string(rs)\n" +
        "}\n",
    },
  },
  {
    id: "go-fix-nil-map",
    title: "修复向 nil map 赋值的 panic",
    lang: "go",
    kind: "fix",
    prompt: "words.go 的 CountWords 一运行就 panic。请修复它，使 `go run .` 输出 ok。",
    requires: ["go"],
    verifyFiles: ["main.go", "go.mod"],
    files: {
      "go.mod": GO_MOD,
      "words.go":
        "package main\n\n" +
        'import "strings"\n\n' +
        "// CountWords 统计每个单词出现的次数。\n" +
        "func CountWords(s string) map[string]int {\n" +
        "\tvar counts map[string]int\n" +
        "\tfor _, w := range strings.Fields(s) {\n" +
        "\t\tcounts[w]++\n" +
        "\t}\n" +
        "\treturn counts\n" +
        "}\n",
      "main.go":
        "package main\n\n" +
        'import (\n\t"fmt"\n\t"os"\n)\n\n' +
        CHECK_HELPERS +
        "\nfunc main() {\n" +
        '\tm := CountWords("a b a")\n' +
        '\tcheck(m["a"] == 2, `m["a"]`)\n' +
        '\tcheck(m["b"] == 1, `m["b"]`)\n' +
        '\tcheck(len(CountWords("")) == 0, "empty")\n' +
        '\tfmt.Println("ok")\n' +
        "}\n",
    },
    verify: { cmd: "go", args: ["run", "."] },
    solution: {
      "words.go":
        "package main\n\n" +
        'import "strings"\n\n' +
        "func CountWords(s string) map[string]int {\n" +
        "\tcounts := make(map[string]int)\n" +
        "\tfor _, w := range strings.Fields(s) {\n" +
        "\t\tcounts[w]++\n" +
        "\t}\n" +
        "\treturn counts\n" +
        "}\n",
    },
  },
  {
    id: "go-debug-truncate",
    title: "调试：按字节截断打碎多字节字符",
    lang: "go",
    kind: "debug",
    prompt:
      "text.go 的 Truncate(s, n) 应返回 s 的前 n 个字符，但对中文输入结果是乱码。" +
      "先运行 `go run .` 复现失败，再修复 text.go（不要改 main.go）。",
    requires: ["go"],
    verifyFiles: ["main.go", "go.mod"],
    files: {
      "go.mod": GO_MOD,
      "text.go":
        "package main\n\n" +
        "// Truncate 返回 s 的前 n 个字符；n 超长时返回原串。\n" +
        "func Truncate(s string, n int) string {\n" +
        "\tif len(s) <= n {\n" +
        "\t\treturn s\n" +
        "\t}\n" +
        "\treturn s[:n]\n" +
        "}\n",
      "main.go":
        "package main\n\n" +
        'import (\n\t"fmt"\n\t"os"\n)\n\n' +
        CHECK_HELPERS +
        "\nfunc main() {\n" +
        '\tcheck(Truncate("hello", 3) == "hel", "ascii")\n' +
        '\tcheck(Truncate("你好世界", 2) == "你好", "需按 rune 截断")\n' +
        '\tcheck(Truncate("ab", 5) == "ab", "短串原样返回")\n' +
        '\tfmt.Println("ok")\n' +
        "}\n",
    },
    verify: { cmd: "go", args: ["run", "."] },
    solution: {
      "text.go":
        "package main\n\n" +
        "func Truncate(s string, n int) string {\n" +
        "\trs := []rune(s)\n" +
        "\tif len(rs) <= n {\n" +
        "\t\treturn s\n" +
        "\t}\n" +
        "\treturn string(rs[:n])\n" +
        "}\n",
    },
  },
  {
    id: "go-wire-titlecase",
    title: "新建文件实现 TitleCase 并接进主程序",
    lang: "go",
    kind: "implement",
    prompt:
      "main.go 调用了一个尚不存在的 TitleCase(s)（每个空格分隔的单词首字母大写、其余小写）。" +
      "请新建 stringsx.go（package main）实现它，使 `go run .` 输出 ok。",
    requires: ["go"],
    verifyFiles: ["main.go", "go.mod"],
    files: {
      "go.mod": GO_MOD,
      "main.go":
        "package main\n\n" +
        'import (\n\t"fmt"\n\t"os"\n)\n\n' +
        CHECK_HELPERS +
        "\nfunc main() {\n" +
        '\tcheck(TitleCase("hello world") == "Hello World", "基本")\n' +
        '\tcheck(TitleCase("GO is FUN") == "Go Is Fun", "混合大小写要归一")\n' +
        '\tcheck(TitleCase("") == "", "empty")\n' +
        '\tfmt.Println("ok")\n' +
        "}\n",
    },
    verify: { cmd: "go", args: ["run", "."] },
    solution: {
      "stringsx.go":
        "package main\n\n" +
        'import "strings"\n\n' +
        "func TitleCase(s string) string {\n" +
        "\twords := strings.Fields(s)\n" +
        "\tfor i, w := range words {\n" +
        "\t\twords[i] = strings.ToUpper(w[:1]) + strings.ToLower(w[1:])\n" +
        "\t}\n" +
        '\treturn strings.Join(words, " ")\n' +
        "}\n",
    },
  },
];
