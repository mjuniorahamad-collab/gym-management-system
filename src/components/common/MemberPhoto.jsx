import { useRef, useState } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { initials } from '@/utils/formatters'
import { saveMemberPhoto } from '@/services/photoStore'
import { useMemberPhoto } from '@/hooks/usePhotoStore'
import { useSecureImage } from '@/hooks/useSecureImage'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'

const SIZES = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-14 w-14 text-base',
  lg: 'h-24 w-24 text-2xl',
  xl: 'h-32 w-32 text-3xl',
}

export function MemberPhoto({ member, size = 'md', editable = false, onUpload }) {
  const [uploading, setUploading] = useState(false)
  // The bytes returned by the upload itself, so the new photo is visible before
  // the re-read lands. Tagged with the member they belong to and compared at
  // RENDER time, not reset in an effect: a list reuses this component for
  // whichever row sits in that position, so an untagged value renders the
  // previous member's face under the next member's name for at least one frame
  // (and forever if the row never re-mounts).
  const [localPhoto, setLocalPhoto] = useState(null)
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
  // a list where only some members have a photo. For the ones that do have one,
  // usePhotoStore answers from this session's cache after the first read.
  const hasStoredPhoto = member?.hasPhoto === true
  const { dataUrl: storedUrl } = useMemberPhoto(hasStoredPhoto ? member.id : null)

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !member?.id) return
    setUploading(true)
    try {
      // The bytes are resized to a 320px thumbnail and written to
      // memberPhotos/{memberId}. No public URL and no download token is minted,
      // so nothing is persisted that would outlive this user's access.
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

  // Priority: bytes from the upload in flight → stored thumbnail → a direct
  // Storage path (documents written when Cloud Storage was still intended) →
  // a legacy stored URL. Nothing is fetched when the bytes are already here.
  const localPhotoUrl = localPhoto?.memberId === member?.id ? localPhoto.dataUrl : null
  const { url: photoSrc, loading: photoLoading } = useSecureImage(
    member?.photoPath,
    member?.photoUrl,
    localPhotoUrl || storedUrl
  )

  return (
    <div className="relative inline-block">
      {photoSrc ? (
        <img
          src={photoSrc}
          alt={member.name}
          className={clsx('rounded-full object-cover ring-2 ring-white dark:ring-slate-800', SIZES[size])}
        />
      ) : (
        <div
          className={clsx(
            'flex items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-emerald-500 font-bold text-white',
            SIZES[size]
          )}
          title={photoLoading ? 'Loading photo' : undefined}
        >
          {initials(member?.name || '?')}
        </div>
      )}

      {editable && (
        <>
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-white shadow-md transition-colors hover:bg-slate-700 disabled:opacity-60"
            aria-label="Upload photo"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
          </button>
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
        </>
      )}
    </div>
  )
}
