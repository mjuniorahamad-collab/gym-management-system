import { Button } from './Button'

export function Pagination({ hasMore, loading, onLoadMore, showing, total }) {
  if (!hasMore && !loading) return null
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {typeof showing === 'number' && `${showing} shown`}
        {typeof total === 'number' && ` of ${total}`}
      </p>
      <Button variant="outline" size="sm" onClick={onLoadMore} loading={loading}>
        Load more
      </Button>
    </div>
  )
}
