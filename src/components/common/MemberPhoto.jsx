import { useRef, useState } from 'react'
import { Camera, Loader2, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { initials } from '@/utils/formatters'
import { removeMemberPhoto, saveMemberPhoto } from '@/services/photoStore'
import { useMemberPhoto } from '@/hooks/usePhotoStore'
import { useSecureImage } from '@/hooks/useSecureImage'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

// One scale for every avatar in the app: 36px in tables, 48/56px in cards, 80px
// on the membership card and 128px on the member's own page. The text size is on
// the wrapper so the initials inherit it without a second size map.
const SIZES = {
  sm: 'h-9 w-9 text-[11px]',
  md: 'h-12 w-12 text-sm',
  lg: 'h-20 w-20 text-lg',
  xl: 'h-32 w-32 text-3xl',
  // The member page's face: 80px on a phone leaves room for the name and the
  // contact line beside it, 128px from the small breakpoint up.
  hero: 'h-20 w-20 text-lg sm:h-32 sm:w-32 sm:text-3xl',
}

/**
 * A stable tint per member, derived from the id.
 *
 * Initials avatars used to all share one indigo→emerald gradient, so a page of
 * twelve members without photos was twelve identical circles. A hue from the id
 * keeps the same member the same colour on every screen, and keeps the palette
 * muted enough that a table of them does not turn into confetti.
 */
function initialsTint(seed) {
  const text = typeof seed === 'string' && seed ? seed : '?'
  let hue = 0
  for (let index = 0; index < text.length; index += 1) {
    hue = (hue * 31 + text.charCodeAt(index)) % 360
  }
  return {
    backgroundImage: `linear-gradient(140deg, hsl(${hue} 45% 55%), hsl(${(hue + 42) % 360} 42% 42%))`,
  }
}

export function MemberPhoto({
  member,
  size = 'md',
  editable = false,
  // Replacing a photo and deleting one are different permissions (a front desk
  // may do the first, only owner/admin the second), so removal is opt-in rather
  // than implied by `editable`.
  removable = false,
  onUpload,
  onRemove,
}) {
  const [uploading, setUploading] = useState(false)
  // The bytes returned by the upload itself, so the new photo is visible before
  // the re-read lands. Tagged with the member they belong to and compared at
  // RENDER time, not reset in an effect: a list reuses this component for
  // whichever row sits in that position, so an untagged value renders the
  // previous member's face under the next member's name for at least one frame
  // (and forever if the row never re-mounts).
  const [localPhoto, setLocalPhoto] = useState(null)
  // Removal is the undo of an upload, so it is confirmed like every other
  // destructive action in the app rather than fired on a single tap.
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const inputRef = useRef(null)

  // The gym identity comes from the signed-in users/{uid} profile, which is the
  // same source firestore.rules trusts. It is never taken from the member
  // document, the route, or any other client-controlled value, and a caller
  // cannot override it by passing a prop.
  //
  // useAuth() returns null when no AuthProvider is mounted (some component
  // tests render this in isolation), so the optional chain keeps rendering
  // working; only an actual upload needs the identity, and it fails loudly.
  const gymId = useAuth()?.gymId ?? null
  const toast = useToast()

  // A members page renders 20 rows, and Firestore bills one document read per
  // avatar — whether or not a photo exists. `hasPhoto` is written in the same
  // commit as the bytes (services/photoStore.js), so a row without it is known to
  // have no avatar and asks for nothing: that alone removes most of the reads on
  // a list where only some members have a photo.
  const hasStoredPhoto = member?.hasPhoto === true
  const {
    dataUrl: storedUrl,
    loading: storedLoading,
    refresh: refreshStoredPhoto,
  } = useMemberPhoto(hasStoredPhoto ? member.id : null)

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !member?.id) return
    setUploading(true)
    try {
      // The bytes are resized to a 320px thumbnail and written to
      // memberPhotos/{memberId} in one commit with the member's hasPhoto flag.
      // No public URL and no download token is minted, so nothing is persisted
      // that would outlive this user's access.
      const { dataUrl } = await saveMemberPhoto(gymId, member.id, file)
      setLocalPhoto({ memberId: member.id, dataUrl })
      onUpload?.({ dataUrl })
    } catch (err) {
      // Previously swallowed into console.error, which left the operator
      // clicking a button that silently did nothing.
      console.error('Photo upload failed', err)
      toast.error(err?.message || 'Could not upload photo')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const handleRemove = async () => {
    if (!member?.id) return
    setRemoving(true)
    try {
      await removeMemberPhoto(member.id)
      // The bytes the last upload returned outrank the stored read, so they have
      // to be dropped explicitly or the face would stay on screen.
      setLocalPhoto(null)
      refreshStoredPhoto()
      onRemove?.()
      toast.success('Photo removed')
    } catch (err) {
      console.error('Photo removal failed', err)
      toast.error(err?.message || 'Could not remove photo')
    } finally {
      setRemoving(false)
      setConfirmRemove(false)
    }
  }

  // Priority: bytes from the upload in flight → stored thumbnail → a direct
  // Storage path (documents written when Cloud Storage was still intended) →
  // a legacy stored URL. Nothing is fetched when the bytes are already here.
  const localPhotoUrl = localPhoto?.memberId === member?.id ? localPhoto.dataUrl : null
  const { url: photoSrc, loading: legacyLoading } = useSecureImage(
    member?.photoPath,
    member?.photoUrl,
    localPhotoUrl || storedUrl
  )

  // A photo is on its way (a stored thumbnail being read, or a legacy object
  // being fetched). Until it lands the circle shows a calm skeleton over the
  // initials instead of snapping between two states.
  const loadingPhoto = !photoSrc && (storedLoading || legacyLoading)

  return (
    <div className="group relative inline-block">
      <div
        className={clsx(
          'overflow-hidden rounded-full shadow-sm ring-1 ring-slate-900/10 dark:ring-white/15',
          SIZES[size]
        )}
      >
        {photoSrc ? (
          <img
            src={photoSrc}
            alt={member?.name || ''}
            draggable={false}
            decoding="async"
            loading="lazy"
            className="member-photo-img h-full w-full rounded-full object-cover object-center"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center rounded-full font-bold tracking-wide text-white"
            style={initialsTint(member?.id || member?.name)}
          >
            {initials(member?.name || '?')}
          </div>
        )}

        {loadingPhoto && (
          <div
            data-photo-skeleton
            aria-hidden="true"
            className="absolute inset-0 animate-pulse rounded-full bg-slate-200/80 dark:bg-slate-700/70 print:hidden"
          />
        )}

        {/* Affordance only: the real control is the button below, which is visible
            on touch screens where there is no hover to reveal anything. */}
        {editable && (
          <div
            data-photo-hover
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden items-center justify-center rounded-full bg-slate-950/45 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 print:hidden sm:flex"
          >
            <Camera size={16} className="text-white" />
          </div>
        )}
      </div>

      {editable && (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white print:hidden"
            aria-label="Upload photo"
            title="Upload photo"
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
          </button>
          {removable && photoSrc && (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              disabled={uploading || removing}
              className="absolute -bottom-0.5 -left-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-red-500/15 dark:hover:text-red-400 print:hidden"
              aria-label="Remove photo"
              title="Remove photo"
            >
              <Trash2 size={13} />
            </button>
          )}
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
          <ConfirmDialog
            open={confirmRemove}
            onCancel={() => setConfirmRemove(false)}
            onConfirm={handleRemove}
            loading={removing}
            title="Remove this photo?"
            message={`${member?.name || 'This member'}'s photo will be deleted. You can upload another one at any time.`}
            confirmLabel="Remove photo"
          />
        </>
      )}
    </div>
  )
}
