import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeBlock from "./CodeBlock";
import styles from "./ConversationFlow.module.less";

function codeText(children: ReactNode) {
  return String(children ?? "");
}

export function MarkdownMessage({ children }: { children: string }) {
  return <div className={styles.markdown}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: linkChildren, ...props }) => <a {...props} rel="noopener noreferrer" target="_blank">{linkChildren}</a>,
        pre: ({ children: preChildren }) => {
          if (isValidElement<{ className?: string; children?: ReactNode }>(preChildren)) {
            const language = /language-([^\s]+)/.exec(preChildren.props.className ?? "")?.[1];
            return <CodeBlock code={codeText(preChildren.props.children)} language={language} />;
          }
          return <pre>{preChildren}</pre>;
        },
        code: ({ children: codeChildren, className, node: _node, ...props }) => <code {...props} className={className}>{codeChildren}</code>,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>;
}

export default MarkdownMessage;
