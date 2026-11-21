export interface FontEntry {
  file: string;
  family: string;
}

export interface PoemWordEntry {
  word: string;
  sayori: number;
  natsuki: number;
  yuri: number;
}

export interface ManifestCounts {
  images: number;
  transforms: number;
  audio: number;
  characters: number;
  poems: number;
  labels: number;
  scripts: number;
  gameFiles: number;
}

export interface GameManifest {
  pipelineVersion: number;
  sourceSha256: string;
  logicalWidth: number;
  logicalHeight: number;
  gameFiles: string[];
  characterFiles: string[];
  fonts: FontEntry[];
  poemWords: PoemWordEntry[];
  scriptFiles: string[];
  counts: ManifestCounts;
}

export type GuiConfig = Record<string, unknown>;

export interface AudioDef {
  raw: string;
  path: string;
  from?: number;
  to?: number;
  loop?: number;
}

export interface CharacterDef {
  id: string;
  dynamic: boolean;
  name: string | null;
  kwargs: Record<string, unknown>;
}

export interface PoemDef {
  id: string;
  author: string;
  title: string;
  text: string;
  yuri_2: boolean;
  yuri_3: boolean;
}

export interface DefaultDef {
  store: string;
  varname: string;
  ast: PyExprNode | null;
}

export type PyExprNode =
  | { t: "const"; v: unknown }
  | { t: "name"; id: string }
  | { t: "attr"; obj: PyExprNode; attr: string }
  | { t: "sub"; obj: PyExprNode; key: PyExprNode }
  | {
      t: "slice";
      obj: PyExprNode;
      lower: PyExprNode | null;
      upper: PyExprNode | null;
      step: PyExprNode | null;
    }
  | { t: "list" | "tuple"; elts: PyExprNode[] }
  | { t: "dict"; keys: PyExprNode[]; vals: PyExprNode[] }
  | { t: "unary"; op: string; arg: PyExprNode }
  | { t: "bin"; op: string; l: PyExprNode; r: PyExprNode }
  | { t: "bool"; op: "and" | "or"; vals: PyExprNode[] }
  | { t: "cmp"; left: PyExprNode; ops: string[]; comps: PyExprNode[] }
  | { t: "ifexp"; test: PyExprNode; body: PyExprNode; else: PyExprNode }
  | {
      t: "call";
      fn: PyExprNode;
      args: PyExprNode[];
      kwargs: Array<{ k: string; v: PyExprNode }>;
    }
  | { t: "gen"; elt: PyExprNode; target: PyExprNode; iter: PyExprNode }
  | { t: "raw"; src: string };

export type PyStmtNode =
  | { t: "assign"; targets: PyExprNode[]; val: PyExprNode }
  | { t: "aug"; op: string; target: PyExprNode; val: PyExprNode }
  | { t: "expr"; val: PyExprNode }
  | { t: "if"; test: PyExprNode; body: PyStmtNode[]; else: PyStmtNode[] }
  | { t: "while"; test: PyExprNode; body: PyStmtNode[] }
  | { t: "for"; target: PyExprNode; iter: PyExprNode; body: PyStmtNode[] }
  | { t: "try"; body: PyStmtNode[]; handlers: PyStmtNode[][] }
  | {
      t: "with";
      items: Array<{ ctx: PyExprNode; var: PyExprNode | null }>;
      body: PyStmtNode[];
    }
  | { t: "del"; targets: PyExprNode[] }
  | { t: "def"; name: string; args: string[]; body: PyStmtNode[] }
  | { t: "class"; name: string; body: PyStmtNode[] }
  | { t: "return"; val: PyExprNode | null }
  | { t: "pass" | "break" | "continue" | "noop" }
  | { t: "global"; names: string[] }
  | { t: "import"; names: string[] };

export interface CompositeLayer {
  x: number;
  y: number;
  image: ImageDef;
}

export type ImageDef =
  | { kind: "color"; hex: string }
  | { kind: "file"; path: string }
  | { kind: "composite"; size: [number, number]; layers: CompositeLayer[] }
  | { kind: "tile"; child: ImageDef }
  | { kind: "flip"; child: ImageDef; horizontal: boolean; vertical: boolean }
  | { kind: "crop"; child: ImageDef; rect: [number, number, number, number] }
  | { kind: "scale"; child: ImageDef; factor: number }
  | { kind: "matrixColor"; child: ImageDef; matrix: string }
  | { kind: "alpha"; child: ImageDef; alpha: number }
  | {
      kind: "conditionSwitch";
      branches: Array<{
        condition: string;
        condAst: PyExprNode | null;
        image: ImageDef;
      }>;
    }
  | {
      kind: "animatedMask";
      child: ImageDef;
      mask: string;
      maskb: string;
      oc: number;
      op: number;
      moving: boolean;
      speed: number;
      frequency: number;
      amount: number;
    }
  | {
      kind: "text";
      parameterized: boolean;
      text: string | null;
      props: Record<string, unknown>;
    }
  | { kind: "atl"; steps: AtlStatement[]; preview: ImageDef | null }
  | { kind: "expr"; raw: string };

export interface AtlExpression {
  expr: string;
  with: string | null;
}

export type AtlStatement =
  | {
      type: "step";
      warper?: string;
      warpFunction?: string;
      duration?: string;
      expressions?: AtlExpression[];
      properties?: [string, string][];
      circles?: string;
    }
  | { type: "parallel"; blocks: AtlStatement[][] }
  | {
      type: "choice";
      choices: Array<{ weight: number | string; block: AtlStatement[] }>;
    }
  | { type: "repeat"; count: number | null }
  | { type: "time"; time: string }
  | { type: "on"; handlers: Record<string, AtlStatement[]> }
  | { type: "event"; name: string }
  | { type: "block"; statements: AtlStatement[] }
  | { type: "function"; expr: string }
  | { type: "contains"; expr: string }
  | { type: "child"; blocks: AtlStatement[][] }
  | { type: string };

export interface TransformParam {
  name: string;
  default: string | null;
}

export interface TransformDef {
  name: string;
  params: TransformParam[];
  steps: AtlStatement[];
}

export interface ImageSpec {
  name: string[];
  expression?: string;
  exprAst?: PyExprNode | null;
  tag?: string;
  at?: string[];
  layer?: string;
  zorder?: string;
  behind?: string[];
}

export interface MenuItemNode {
  caption: string | null;
  condition: string;
  condAst: PyExprNode | null;
  block: ScriptStatement[] | null;
}

export interface IfBranchNode {
  condition: string;
  condAst: PyExprNode | null;
  block: ScriptStatement[];
}

export interface CallArg {
  name: string | null;
  expr: string;
  ast: PyExprNode | null;
}

export interface LabelParamDef {
  name: string;
  defaultAst: PyExprNode | null;
}

export type ScriptStatement =
  | {
      type: "init";
      priority: number;
      block: ScriptStatement[];
      line: number;
    }
  | {
      type: "label";
      name: string;
      params: string[];
      paramDefs?: LabelParamDef[];
      block: ScriptStatement[];
      line: number;
    }
  | {
      type: "say";
      who: string | null;
      what: string;
      attributes?: string[];
      with?: string;
      interact?: boolean;
      line: number;
    }
  | {
      type: "scene";
      imspec: ImageSpec;
      layer: string;
      atl?: AtlStatement[];
      line: number;
    }
  | {
      type: "show";
      imspec: ImageSpec;
      atl?: AtlStatement[];
      line: number;
    }
  | { type: "hide"; imspec: ImageSpec; line: number }
  | {
      type: "with";
      expr: string | null;
      exprAst?: PyExprNode | null;
      paired: string | null;
      line: number;
    }
  | {
      type: "jump";
      target: string;
      expression: boolean;
      targetAst?: PyExprNode | null;
      line: number;
    }
  | {
      type: "call";
      label: string;
      expression: boolean;
      labelAst?: PyExprNode | null;
      args: CallArg[];
      line: number;
    }
  | {
      type: "return";
      expression: string | null;
      exprAst?: PyExprNode | null;
      line: number;
    }
  | { type: "menu"; items: MenuItemNode[]; line: number }
  | { type: "if"; branches: IfBranchNode[]; line: number }
  | {
      type: "while";
      condition: string;
      condAst: PyExprNode | null;
      block: ScriptStatement[];
      line: number;
    }
  | {
      type: "python";
      early: boolean;
      code: string;
      pyAst: PyStmtNode[];
      line: number;
    }
  | {
      type: "default" | "define";
      store: string;
      varname: string;
      code: string;
      pyAst: PyExprNode | null;
      line: number;
    }
  | {
      type: "play";
      channel: string;
      args: string;
      line: number;
    }
  | {
      type: "queue";
      channel: string;
      args: string;
      line: number;
    }
  | {
      type: "stop";
      channel: string;
      args: string;
      line: number;
    }
  | {
      type: "pause";
      duration: string | null;
      durationAst?: PyExprNode | null;
      line: number;
    }
  | {
      type: "window";
      mode: string;
      transition: string | null;
      line: number;
    }
  | {
      type: "screen";
      action: "show" | "hide" | "call";
      name: string;
      argsRaw: string | null;
      callAst: PyExprNode | null;
      line: number;
    }
  | {
      type: "showLayer";
      layer: string;
      at: string[];
      atl?: AtlStatement[];
      line: number;
    }
  | { type: "pass"; line: number }
  | { type: string; line: number };

export interface ScriptFile {
  name: string;
  statements: ScriptStatement[];
}

export interface ScriptIndex {
  scripts: string[];
  labels: Record<string, string>;
}
