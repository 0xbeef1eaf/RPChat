import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ title, children, actions }: EmptyStateProps) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children ? <div>{children}</div> : null}
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  );
}
