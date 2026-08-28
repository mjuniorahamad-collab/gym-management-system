import { useRef, useState } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { initials } from '@/utils/formatters'
import { memberPhotoPath, uploadFile } from '@/services/storage'

const SIZES = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-14 w-14 text-base',
  lg: 'h-24 w-24 text-2xl',
  xl: 'h-32 w-32 text-3xl',
}

export function MemberPhoto({ member, size = 'md', editable = false, onUpload }) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef(null)

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !member?.id) return
    setUploading(true)
    try {
      const url = await uploadFile(file, memberPhotoPath(member.id))
      onUpload?.(url)
    } catch (err) {
      console.error('Upload failed', err)
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="relative inline-block">
      {member?.photoUrl ? (
        <img
          src={member.photoUrl}
          alt={member.name}
          className={clsx('rounded-full object-cover ring-2 ring-white dark:ring-slate-800', SIZES[size])}
        />
      ) : (
        <div
          className={clsx(
            'flex items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-emerald-500 font-bold text-white',
            SIZES[size]
          )}
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
