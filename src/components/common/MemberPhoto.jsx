import { useRef, useState } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { initials } from '@/utils/formatters'
import { uploadMemberPhoto } from '@/services/storage'
import { useSecureImage } from '@/hooks/useSecureImage'
import { useAuth } from '@/context/AuthContext'

const SIZES = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-14 w-14 text-base',
  lg: 'h-24 w-24 text-2xl',
  xl: 'h-32 w-32 text-3xl',
}

export function MemberPhoto({ member, size = 'md', editable = false, onUpload }) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef(null)

  // The gym identity comes from the signed-in users/{uid} profile, which is the
  // same source storage.rules trusts. It is never taken from the member
  // document, the route, or any other client-controlled value, and a caller
  // cannot override it by passing a prop.
  //
  // useAuth() returns null when no AuthProvider is mounted (some component
  // tests render this in isolation), so the optional chain keeps rendering
  // working; only an actual upload needs the identity, and it fails loudly.
  const gymId = useAuth()?.gymId ?? null

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !member?.id) return
    setUploading(true)
    try {
      // The upload returns a PATH, not a URL. No download token is minted, so
      // nothing is written to the member document that would outlive this
      // user's access.
      const { path } = await uploadMemberPhoto(gymId, member.id, file)
      onUpload?.({ path })
    } catch (err) {
      console.error('Upload failed', err)
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  // Photos are read from the stored path, so every render is checked against
  // storage.rules. `member.photoUrl` is only consulted for documents that predate
  // the path field; once a path exists it is never used as the access mechanism.
  const { url: photoSrc, loading: photoLoading } = useSecureImage(member?.photoPath, member?.photoUrl)

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
