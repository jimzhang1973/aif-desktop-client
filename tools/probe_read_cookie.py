import ctypes
from ctypes import wintypes, POINTER, Structure, cast, c_void_p, c_wchar_p

class CREDENTIAL(Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", c_wchar_p),
        ("Comment", c_wchar_p),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", c_void_p),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", c_void_p),
        ("TargetAlias", c_wchar_p),
        ("UserName", c_wchar_p),
    ]

advapi32 = ctypes.windll.advapi32
target = "bs_session_cookie.aif-desktop-client"
p_cred = POINTER(CREDENTIAL)()
ret = advapi32.CredReadW(c_wchar_p(target), 1, 0, ctypes.byref(p_cred))
if not ret:
    print("CREDREAD_FAIL", ctypes.GetLastError())
else:
    cred = p_cred.contents
    print("TargetName:", cred.TargetName)
    print("UserName:", cred.UserName)
    size = cred.CredentialBlobSize
    blob = cast(cred.CredentialBlob, POINTER(ctypes.c_byte * size)).contents
    data = bytes(blob)
    try:
        text = data.decode("utf-16-le")
    except Exception as e:
        text = repr(data)
    print("BlobLen:", size)
    print("Cookie:", text)
    advapi32.CredFree(p_cred)
