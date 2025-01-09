import { autocompletion, startCompletion } from "@codemirror/autocomplete";
import {
  HighlightStyle,
  StreamLanguage,
  StringStream,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { EditorView, minimalSetup } from "codemirror";
import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { FontSize, TextStyle } from "../../appearance/Fonts.mjs";
import { filterSamples, scoreFilterItems } from "./filters.mjs";
import {
  kScoreTypeBoolean,
  kScoreTypeCategorical,
  kScoreTypeNumeric,
  kScoreTypeOther,
  kScoreTypePassFail,
} from "../../constants.mjs";
import { keymap } from "@codemirror/view";

/**
 * @typedef {Object} Token
 * @property {string} type
 * @property {string} text
 * @property {number} from
 * @property {number} to
 */

/**
 * @typedef {Object} FilteringResult
 * @property {number} numSamples - The number of samples that match the filter.
 * @property {import("./filters.mjs").FilterError | undefined} error - The error in the filter expression, if any.
 */

const KEYWORDS = ["and", "or", "not", "in", "not in", "mod"];

const MATH_FUNCTIONS = [
  ["min", "Minimum of two or more values"],
  ["max", "Maximum of two or more values"],
  ["abs", "Absolute value"],
  ["round", "Round to the nearest integer"],
  ["floor", "Round down to the nearest integer"],
  ["ceil", "Round up to the nearest integer"],
  ["sqrt", "Square root"],
  ["log", "Natural logarithm"],
  ["log2", "Base 2 logarithm"],
  ["log10", "Base 10 logarithm"],
];

const SAMPLE_FUNCTIONS = [
  ["input_contains", "Checks if input contains a regular expression"],
  ["target_contains", "Checks if target contains a regular expression"],
];

/**
 * Makes sure that the filter expression is a single line.
 * @param {import("@codemirror/state").Transaction} tr - The transaction to join lines in.
 * @returns {import("@codemirror/state").TransactionSpec} The transaction with joined lines, if any.
 */
function ensureOneLine(tr) {
  const newDoc = tr.newDoc.toString();
  if (newDoc.includes("\n")) {
    if (tr.isUserEvent("input.paste")) {
      const newDocAdjusted = newDoc.replace(/\n/g, " ").trim();
      return {
        changes: {
          from: 0,
          to: tr.startState.doc.length,
          insert: newDocAdjusted,
        },
      };
    } else {
      return {};
    }
  }
  return tr;
}

// Based on CodeMirror default theme: https://codemirror.net/5/lib/codemirror.css
const highlightStyle = HighlightStyle.define([
  { tag: tags.string, color: "#a11" },
  { tag: tags.number, color: "#164" },
  { tag: tags.keyword, color: "#708" },
  { tag: tags.function(tags.variableName), color: "#00c" },
]);

/** @param {string} word */
function countSpaces(word) {
  return word.split(" ").length - 1;
}

const nextToken = (() => {
  const wordsRe = (words) => new RegExp(`^(${words.join("|")})\\b`);
  const keywordsRe = wordsRe(
    // Sort to make sure "not in" is matched before "not".
    KEYWORDS.sort((a, b) => countSpaces(b) - countSpaces(a)),
  );
  const mathFunctionsRe = wordsRe(MATH_FUNCTIONS.map(([label]) => label));
  const sampleFunctionsRe = wordsRe(SAMPLE_FUNCTIONS.map(([label]) => label));

  /** @param {import("@codemirror/language").StringStream} stream */
  return function (stream) {
    if (stream.match(/"[^"]*"/)) return "string";
    if (stream.match(/"[^"]*/)) return "unterminatedString";
    if (stream.match(/^(-|\+)?\d+(\.\d+)?/)) return "number";
    if (stream.match(keywordsRe)) return "keyword";
    if (stream.match(mathFunctionsRe)) return "mathFunction";
    if (stream.match(sampleFunctionsRe)) return "sampleFunction";
    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) return "variable";
    if (stream.match(/^(==|!=|<=|>=|<|>|~=)/)) return "relation";
    if (stream.match(/^(=|!|~)/)) return "miscOperator"; // recognize relations while typing; not valid syntax per se
    if (stream.match(/^(\+|-|\*|\/|\^|\(|\)|,|\.)/)) return "miscOperator";
    stream.next();
    return null;
  };
})();

const language = StreamLanguage.define({
  token: nextToken,
  tokenTable: {
    string: tags.string,
    unterminatedString: tags.string,
    number: tags.number,
    keyword: tags.keyword,
    mathFunction: tags.function(tags.variableName),
    sampleFunction: tags.function(tags.variableName),
    variable: tags.variableName,
    relation: tags.operator,
    miscOperator: tags.operator,
  },
});

/**
 * @param {string} input
 * @returns {Token[]}
 */
function tokenize(input) {
  const tokens = [];
  const stream = new StringStream(input, 0, 0);
  while (stream.pos < input.length) {
    const from = stream.pos;
    const type = nextToken(stream);
    if (type) {
      tokens.push({
        type,
        text: input.slice(from, stream.pos),
        from,
        to: stream.pos,
      });
    }
  }
  return tokens;
}

/**
 * @param {import("./filters.mjs").ScoreFilterItem[]} filterItems
 * @param {string} scorer
 * @returns {import("./filters.mjs").ScoreFilterItem[]}
 */
function getMemberScoreItems(filterItems, scorer) {
  return filterItems.filter((item) =>
    item?.qualifiedName?.startsWith(`${scorer}.`),
  );
}

/**
 * Generates completions for the filter expression. The main goal is to make the
 * sample filter intuitive for beginners and to provide a smooth experience for
 * simple cases. To this end, we proactively try to suggest the next step of the
 * expression, in a wizard-style fashion. This logic is primarily intended to
 * support unsophisticated expressions of the form
 *   SUBEXPR and/or SUBEXPR or/not SUBEXPR ...
 * where each SUBEXPR is
 *   VARIABLE ==/!=/</>/in/... VALUE
 * and VALUE is a literal (string, number, etc.)
 * It does support some expressions more complex than that, but the completion
 * algorithm is not intended to be comprehensive. This is why we usually add
 * default completions to the list in case our guess was off.
 *
 * @param {import("@codemirror/autocomplete").CompletionContext} context
 * @param {import("../../samples/tools/filters.mjs").ScoreFilterItem[]} filterItems
 * @returns {import("@codemirror/autocomplete").CompletionResult}
 */
function getCompletions(context, filterItems) {
  /** @param {Token} token */
  const isLiteral = (token) =>
    ["string", "unterminatedString", "number"].includes(token?.type);
  /** @param {Token} token */
  const isLogicalOp = (token) => ["and", "or", "not"].includes(token?.text);

  /**
   * With most tokens we complete only after a space, but for sometimes it makes
   * sense to start autocompletion as soon as the token was typed.
   * @param {Token} token
   */
  const autocompleteImmediatelyAfter = (token) =>
    ["(", "."].includes(token?.text);

  /**
   * @param {import("codemirror").EditorView} view
   * @param {import("@codemirror/autocomplete").Completion} completion
   * @param {number} from
   * @param {number} to
   */
  function applyWithCall(view, completion, from, to) {
    view.dispatch({
      changes: { from, to, insert: `${completion.label}()` },
      selection: { anchor: from + completion.label.length + 1 },
    });
  }

  /** @type {(k: string) => import("@codemirror/autocomplete").Completion} */
  const makeKeywordCompletion = (k) => ({
    label: k,
    type: "keyword",
    boost: -20,
  });
  /** @type {([label, info]: [string, string]) => import("@codemirror/autocomplete").Completion} */
  const makeMathFunctionCompletion = ([label, info]) => ({
    label,
    type: "function",
    info,
    apply: applyWithCall,
    boost: -10,
  });
  /** @type {([label, info]: [string, string]) => import("@codemirror/autocomplete").Completion} */
  const makeSampleFunctionCompletion = ([label, info]) => ({
    label,
    type: "function",
    info,
    apply: applyWithCall,
    boost: 0,
  });
  /** @type {(k: string) => import("@codemirror/autocomplete").Completion} */
  const makeLiteralCompletion = (k) => ({
    label: k,
    type: "text",
    boost: 10,
  });
  /**
   * @param {import("./filters.mjs").ScoreFilterItem} item
   * @param {(item: import("./filters.mjs").ScoreFilterItem) => boolean} autoSpaceIf
   * @returns {import("@codemirror/autocomplete").Completion}
   */
  const makeCanonicalNameCompletion = (item, autoSpaceIf = () => false) => ({
    label: item.canonicalName + (autoSpaceIf(item) ? " " : ""),
    type: "variable",
    info: item.tooltip,
    boost: 20,
  });
  /** @type {(item: import("./filters.mjs").ScoreFilterItem) => import("@codemirror/autocomplete").Completion} */
  const makeMemberAccessCompletion = (item) => ({
    label: item.qualifiedName.split(".")[1],
    type: "variable",
    info: item.tooltip,
    boost: 20,
  });

  const keywordCompletionItems = KEYWORDS.map(makeKeywordCompletion);
  const mathFunctionCompletionItems = MATH_FUNCTIONS.map(
    makeMathFunctionCompletion,
  );
  const sampleFunctionCompletionItems = SAMPLE_FUNCTIONS.map(
    makeSampleFunctionCompletion,
  );
  const variableCompletionItems = filterItems.map((item) =>
    makeCanonicalNameCompletion(item),
  );

  const defaultCompletionItems = [
    ...keywordCompletionItems,
    ...mathFunctionCompletionItems,
    ...sampleFunctionCompletionItems,
    ...variableCompletionItems,
  ];

  const input = context.state.doc.toString().slice(0, context.pos);
  const tokens = tokenize(input);
  const lastToken = tokens[tokens.length - 1];
  const isCompletionInsideToken =
    lastToken &&
    context.pos == lastToken.to &&
    !autocompleteImmediatelyAfter(lastToken);
  const currentTokenIndex = isCompletionInsideToken
    ? tokens.length - 1
    : tokens.length; // `currentToken` is undefined when we are not inside a token

  /**
   * Returns nth token back away from the current token. Note that `prevToken(0)`
   * is always reserved for the current token, whether it exists or not.
   * @param {number} index
   * @returns {Token | undefined}
   */
  const prevToken = (index) => tokens[currentTokenIndex - index];

  const currentToken = prevToken(0);
  const completionStart = currentToken ? currentToken.from : context.pos;

  /**
   * @param {number} endIndex
   * @returns {import("../../samples/tools/filters.mjs").ScoreFilterItem | undefined}
   */
  const findFilterItem = (endIndex) => {
    if (prevToken(endIndex)?.type == "variable") {
      let name = prevToken(endIndex).text;
      let i = endIndex;
      while (prevToken(i + 1)?.text == ".") {
        if (prevToken(i + 2)?.type == "variable") {
          name = prevToken(i + 2).text + "." + name;
          i += 2;
        } else {
          break;
        }
      }
      return filterItems.find((item) => item.canonicalName == name);
    }
    return undefined;
  };

  /**
   * @param {import("@codemirror/autocomplete").Completion[]} priorityCompletions
   * @param {Object} props
   * @param {boolean} [props.enforceOrder] - If true, the priorityCompletions are shown in the order they are provided.
   * @param {boolean} [props.autoSpaceAfter] - If true, space is inserted after priorityCompletions. Use when fairly certain that the expression continues.
   * @param {boolean} [props.includeDefault] - If true, the default completions are included after the priority completions.
   * @returns {import("@codemirror/autocomplete").CompletionResult}
   */
  const makeCompletions = (
    priorityCompletions,
    {
      enforceOrder = false,
      autoSpaceAfter = false,
      includeDefault = true,
    } = {},
  ) => {
    const priorityCompletionsOrdered = enforceOrder
      ? priorityCompletions.map((c, idx) => ({
          ...c,
          boost: -idx,
        }))
      : priorityCompletions;
    const priorityCompletionsAdjusted = autoSpaceAfter
      ? priorityCompletionsOrdered.map((c) =>
          !c.apply && !c.label.endsWith(" ")
            ? { ...c, label: c.label + " " }
            : c,
        )
      : priorityCompletionsOrdered;
    if (includeDefault) {
      /** @type {import("@codemirror/autocomplete").CompletionSection} */
      const miscSection = {
        name: "misc",
        header: () => {
          const element = document.createElement("hr");
          element.style.display = "list-item";
          element.style.margin = "2px 0";
          return element;
        },
      };
      const priorityLabels = new Set(priorityCompletions.map((c) => c.label));
      const defaultCompletionAdjusted = priorityCompletions
        ? defaultCompletionItems
            .filter((c) => !priorityLabels.has(c.label))
            .map((c) => ({ ...c, section: miscSection }))
        : defaultCompletionItems;
      return {
        from: completionStart,
        options: [...priorityCompletionsAdjusted, ...defaultCompletionAdjusted],
      };
    } else {
      return {
        from: completionStart,
        options: priorityCompletionsAdjusted,
      };
    }
  };
  const defaultCompletions = () => makeCompletions([]);
  const noCompletions = () => (context.explicit ? defaultCompletions() : null);
  const newExpressionCompletions = () =>
    makeCompletions([
      ...filterItems.map((item) =>
        makeCanonicalNameCompletion(
          item,
          (item) => item.scoreType != kScoreTypeBoolean,
        ),
      ),
      ...sampleFunctionCompletionItems,
    ]);
  const variableCompletions = () => makeCompletions(variableCompletionItems);
  /** @param {import("./filters.mjs").ScoreFilterItem[]} items */
  const memberAccessCompletions = (items) =>
    makeCompletions(items.map(makeMemberAccessCompletion), {
      includeDefault: false,
    });
  const logicalOpCompletions = () =>
    makeCompletions(["and", "or"].map(makeKeywordCompletion), {
      enforceOrder: true,
      autoSpaceAfter: true,
    });
  const descreteRelationCompletions = () =>
    makeCompletions(["==", "!=", "in", "not in"].map(makeKeywordCompletion), {
      enforceOrder: true,
      autoSpaceAfter: true,
    });
  const continuousRelationCompletions = () =>
    makeCompletions(
      ["<", "<=", ">", ">=", "==", "!="].map(makeKeywordCompletion),
      { enforceOrder: true, autoSpaceAfter: true },
    );
  const customRelationCompletions = () =>
    makeCompletions(
      ["<", "<=", ">", ">=", "==", "!=", "~="].map(makeKeywordCompletion),
      { enforceOrder: true, autoSpaceAfter: true },
    );
  /** @param {string[]} options */
  const rhsCompletions = (options) =>
    makeCompletions(options.map(makeLiteralCompletion));

  if (!prevToken(1)) return newExpressionCompletions();

  // Member access
  if (prevToken(1)?.text == ".") {
    const scorer = prevToken(2)?.text;
    if (scorer) {
      return memberAccessCompletions(getMemberScoreItems(filterItems, scorer));
    }
  }

  // Start of a function call or of a bracketed expression
  if (prevToken(1)?.text == "(") {
    if (prevToken(2)?.type == "mathFunction") return variableCompletions();
    if (prevToken(2)?.type == "sampleFunction") {
      // All sample functions expect a literal (a string to search for).
      return noCompletions();
    }
    // A grouping parenthesis, not a function call.
    return newExpressionCompletions();
  }

  // End of a function call or of a bracketed expression
  if (prevToken(1)?.text == ")") {
    // Don't try to guess: too unpredictable. Could continue with an arithmetic
    // operator (if constructing a complex expression), with a comparison (if
    // comparing function call result to something) or with a logical connector
    // (if a new subexpression is starting). Very hard to figure out what is
    // going on without an AST, which we don't have here.
    return noCompletions();
  }

  // Suggest relation based on variable type
  if (prevToken(1)?.type == "variable") {
    const scoreType = findFilterItem(1)?.scoreType;
    if ([kScoreTypePassFail, kScoreTypeCategorical].includes(scoreType))
      return descreteRelationCompletions();
    if (scoreType == kScoreTypeNumeric) return continuousRelationCompletions();
    if (scoreType == kScoreTypeOther) return customRelationCompletions();
    if (scoreType == kScoreTypeBoolean) return logicalOpCompletions();
  }

  // Suggest comparison RHS based on the LHS
  if (prevToken(1)?.type == "relation") {
    const item = findFilterItem(2);
    if (item) {
      if (item?.categories?.length) {
        return rhsCompletions(item.categories);
      } else {
        // Technically, it's possible to compare two scores, but comparison to a
        // constant is much more likely.
        return noCompletions();
      }
    } else {
      // Most likely: comparison starting from a constant, perhaps beginning of
      // a chain comparison.
      return variableCompletions();
    }
  }

  // Suggest connector to the next subexpression after `VARIABLE OP VALUE` subexpression finished.
  if (isLiteral(prevToken(1)) && prevToken(2)?.type == "relation") {
    return logicalOpCompletions();
  }

  // New subexpression begins after a logical connector.
  if (isLogicalOp(prevToken(1))) return newExpressionCompletions();

  // Something unusual is going on. We don't have any good guesses, but the user
  // can trigger completion manually with Ctrl+Space if they want.
  return noCompletions();
}

/**
 * @param {import("codemirror").EditorView} view
 * @param {import("./filters.mjs").FilterError | undefined} filterError
 * @returns {import("@codemirror/lint").Diagnostic[]}
 */
function getLints(view, filterError) {
  if (!filterError) return [];
  return [
    {
      from: filterError.from || 0,
      to: filterError.to || view.state.doc.length,
      severity: filterError.severity,
      message: filterError.message,
    },
  ];
}

// Emulate `form-control` style to make it look like a text input.
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "inherit",
    color: "var(--bs-body-color)",
    backgroundColor: "var(--bs-body-bg)",
    border: "1px solid var(--bs-border-color)",
    borderRadius: "var(--bs-border-radius)",
  },
  "&.cm-focused": {
    outline: "none",
    borderColor: "#86b7fe",
    boxShadow: "0 0 0 0.25rem rgba(13, 110, 253, 0.25)",
  },
  ".cm-scroller": {
    overflow: "hidden",
  },
});

/**
 * @param {import("../../samples/SamplesDescriptor.mjs").EvalDescriptor} evalDescriptor
 * @param {string} filterValue
 * @returns {FilteringResult}
 */
const getFilteringResult = (evalDescriptor, filterValue) => {
  const { result, error } = filterSamples(
    evalDescriptor,
    evalDescriptor.samples,
    filterValue,
  );
  return { numSamples: result.length, error };
};

/**
 * Renders the Sample Filter Control
 *
 * @param {Object} props - The parameters for the component.
 * @param {import("../../samples/SamplesDescriptor.mjs").EvalDescriptor} props.evalDescriptor
 * @param {(filter: import("../../Types.mjs").ScoreFilter) => void} props.filterChanged - Filter changed function
 * @param {import("../../Types.mjs").ScoreFilter} props.filter - Filter that is currently applied.
 * @returns {import("preact").JSX.Element | string} The TranscriptView component.
 */
export const SampleFilter = ({ evalDescriptor, filter, filterChanged }) => {
  const editorRef = useRef(/** @type {HTMLElement|null} */ (null));
  const editorViewRef = useRef(
    /** @type {import("codemirror").EditorView|null} */ (null),
  );
  const lastFilterRef = useRef(/** @type {string|null} */ (null));
  const pendingFilterRef = useRef(/** @type {string|null} */ (null));
  const linterCompartment = useRef(new Compartment());
  const autocompletionCompartment = useRef(new Compartment());
  const updateListenerCompartment = useRef(new Compartment());
  const keymapCompartment = useRef(new Compartment());
  const [hasPendingChanges, setHasPendingChanges] = useState(false);
  const filterItems = useMemo(
    () => scoreFilterItems(evalDescriptor),
    [evalDescriptor],
  );
  const [filteringResultInstant, setFilteringResultInstant] = useState(
    /** @type {FilteringResult | null} */ (null),
  );
  const [filteringResultExplicit, setFilteringResultExplicit] = useState(
    /** @type {FilteringResult | null} */ (null),
  );

  /** @param {import("codemirror").EditorView} view */
  const handleEnter = (view) => {
    const newFilter = view.state.doc.toString();
    const newFilteringResult = getFilteringResult(evalDescriptor, newFilter);
    if (newFilteringResult?.error) {
      setFilteringResultExplicit(newFilteringResult);
    } else {
      lastFilterRef.current = newFilter;
      filterChanged({ value: newFilter });
      setHasPendingChanges(false);
    }
    return true;
  };

  const handleFocus = (event, view) => {
    if (view.state.doc.toString() === "") {
      setTimeout(() => startCompletion(view), 0);
    }
  };

  const makeAutocompletion = () =>
    autocompletion({
      override: [(context) => getCompletions(context, filterItems)],
      activateOnCompletion: (c) => c.label.endsWith(" "), // see autoSpaceAfter
    });
  const makeLinter = () =>
    // CodeMirror debounces the linter, so even instant error updates are not annoying
    linter((view) => getLints(view, filteringResultInstant?.error));
  const makeUpdateListener = () =>
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const newValue = update.state.doc.toString();
        pendingFilterRef.current = newValue;
        setHasPendingChanges(
          newValue.trim() !== (lastFilterRef.current || "").trim(),
        );
        setFilteringResultInstant(getFilteringResult(evalDescriptor, newValue));
        setFilteringResultExplicit(null);
      }
    });
  const makeKeymap = () =>
    keymap.of([
      {
        key: "Enter",
        run: handleEnter,
        preventDefault: true,
      },
    ]);

  // Initialize editor when component mounts
  useEffect(() => {
    editorViewRef.current?.destroy();
    editorViewRef.current = new EditorView({
      parent: editorRef.current,
      state: EditorState.create({
        doc: filter.value || "",
        extensions: [
          keymapCompartment.current.of(makeKeymap()),
          minimalSetup,
          bracketMatching(),
          editorTheme,
          EditorState.transactionFilter.of(ensureOneLine),
          updateListenerCompartment.current.of(makeUpdateListener()),
          EditorView.domEventHandlers({
            focus: handleFocus,
          }),
          language,
          syntaxHighlighting(highlightStyle),
          autocompletionCompartment.current.of(makeAutocompletion()),
          linterCompartment.current.of(makeLinter()),
        ],
      }),
    });
    return () => {
      editorViewRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    if (editorViewRef.current && filter.value !== lastFilterRef.current) {
      lastFilterRef.current = filter.value;
      pendingFilterRef.current = filter.value;
      setHasPendingChanges(false);
      setFilteringResultInstant(
        getFilteringResult(evalDescriptor, filter.value),
      );
      setFilteringResultExplicit(null);
      editorViewRef.current.dispatch({
        changes: {
          from: 0,
          to: editorViewRef.current.state.doc.length,
          insert: filter.value || "",
        },
      });
      editorViewRef.current.focus();
      editorViewRef.current.dispatch({
        selection: { anchor: editorViewRef.current.state.doc.length },
      });
    }
  }, [evalDescriptor, filter.value]);

  useEffect(() => {
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({
        effects: [
          updateListenerCompartment.current.reconfigure(makeUpdateListener()),
          keymapCompartment.current.reconfigure(makeKeymap()),
        ],
      });
    }
  }, [evalDescriptor]);

  useEffect(() => {
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({
        effects:
          autocompletionCompartment.current.reconfigure(makeAutocompletion()),
      });
    }
  }, [filterItems]);

  useEffect(() => {
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({
        effects: linterCompartment.current.reconfigure(makeLinter()),
      });
    }
  }, [filteringResultInstant?.error]);

  /** @type {{cssClass: string, message: string} | undefined} */
  const alertWidget = hasPendingChanges
    ? filteringResultExplicit?.error
      ? {
          cssClass: "alert-danger",
          message: filteringResultExplicit?.error.message,
        }
      : filteringResultInstant?.error
        ? undefined
        : {
            cssClass: "alert-success",
            message: `Press Enter to show ${filteringResultInstant?.numSamples} matching samples`,
          }
    : undefined;

  const EDITOR_WIDTH = 300;
  return html`
    <div style=${{ display: "flex" }}>
      <span
        class="sample-filter-label"
        style=${{
          alignSelf: "center",
          fontSize: FontSize.smaller,
          ...TextStyle.label,
          ...TextStyle.secondary,
          marginRight: "0.3em",
          marginLeft: "0.2em",
        }}
        >Filter:</span
      >
      <div style=${{ position: "relative", width: `${EDITOR_WIDTH}px` }}>
        ${alertWidget !== undefined &&
        createPortal(
          html`<div
            class="alert ${alertWidget.cssClass} py-1 px-2"
            style=${{
              position: "absolute",
              top: editorRef.current?.getBoundingClientRect().top + "px",
              left: editorRef.current?.getBoundingClientRect().left + "px",
              transform: `translateY(-100%)`,
              whiteSpace: "pre-wrap",
              width: `${EDITOR_WIDTH}px`,
              textAlign: "center",
              fontSize: FontSize.smaller,
              boxShadow: "0 0 5px rgba(0,0,0,0.1)",
              borderRadius: "4px",
              zIndex: 2000,
            }}
          >
            ${alertWidget.message}
          </div>`,
          document.body,
        )}
        <div ref=${editorRef}></div>
      </div>
      <span
        class="bi bi-question-circle"
        style=${{
          position: "relative",
          marginLeft: "0.5em",
          cursor: "help",
          alignSelf: "center",
        }}
        data-tooltip=${filterTooltip}
        data-tooltip-position="bottom-left"
      ></span>
    </div>
  `;
};

const filterTooltip = `
Filter samples by:
  • Scores
  • Input and target regex search: input_contains, target_contains

Supported expressions:
  • Arithmetic: +, -, *, /, mod, ^
  • Comparison: <, <=, >, >=, ==, !=, including chain comparisons, e.g. “10 <= x < 20”
  • Boolean: and, or, not
  • Regex matching: ~= (case-sensitive)
  • Set operations: in, not in; e.g. “x in (2, 3, 5)”
  • Functions: min, max, abs, round, floor, ceil, sqrt, log, log2, log10
`.trim();
