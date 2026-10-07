import { AlertCircle } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { safeLoadMessage } from '@/utils/loadErrors'

/**
 * Error slot for a collection/data region that failed to load. Renders in
 * place of the EmptyState so a failure is never mistaken for "you have no
 * data", using the same centered layout as the MemberDetail load-error state.
 *
 * The message is funnelled through safeLoadMessage() at render time as a
 * second line of defence: even if a caller passes a raw Firebase/Firestore
 * error through, only the stable user-facing text reaches the DOM.
 */
export function LoadErrorState({ message, label = 'this data', onRetry }) {
  return (
    <EmptyState
      icon={AlertCircle}
      title={`Couldn't load ${label}`}
      description={safeLoadMessage(message)}
      action={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
    />
  )
}
