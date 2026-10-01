# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
import os
import sys
import pathlib
import shutil
import asyncio
import re
import time
import secrets
import uuid
import argparse
import ctypes
import struct
import zipfile
import io
import tempfile
import subprocess
import concurrent.futures
import sqlite3
import tarfile
import mimetypes
import json
from datetime import datetime
from PIL import Image

# Optional dependencies
try:
    import pikepdf
except ImportError:
    pikepdf = None

try:
    import magic
except ImportError:
    magic = None

# Constants for mlockall
MCL_CURRENT = 1
MCL_FUTURE = 2

class ForensicCleaner:
    def __init__(self, target_dir, delete_files=False, force_self_destruct=False, wipe_mode='nist', rename=False, clean_history_mode=False, target_date=None):
        self.root = pathlib.Path(target_dir).resolve()
        self.delete_files = delete_files
        self.force_self_destruct = force_self_destruct
        self.clean_history_mode = clean_history_mode
        self.wipe_mode = wipe_mode
        self.rename = rename
        self.file_list = []
        self.target_date = target_date  # datetime.date or None
        self.STANDARD_TIME = 1640995200 # Jan 1, 2022 fallback
        self.path_timestamps = {}
        self.timeline_overflow = False
        try:
            self.mime = magic.Magic(mime=True) if magic else None
        except Exception:
            self.mime = None
        self.temp_base = "/dev/shm" if os.path.exists("/dev/shm") else None
        
        self.exiftool = shutil.which('exiftool')
        
        # Process Obfuscation (Phase 4)
        self._obfuscate_process()

        # Lock memory to RAM to prevent swapping (Phase 1)
        self._lock_memory()

    def _initialize_timeline_map(self):
        """Pre-compute a coherent local timeline for files on the selected date."""
        self.timeline_overflow = False
        if not self.target_date:
            return

        self.path_timestamps = {}
        day_window_seconds = 12 * 3600  # 08:00:00 -> 20:00:00
        min_gap_seconds = 10 * 60
        files = sorted((f.resolve() for f in self.file_list), key=lambda p: str(p))
        count = len(files)
        if count == 0:
            return

        if count == 1:
            start_offset = secrets.randbelow(day_window_seconds + 1)
            offsets = [start_offset]
        else:
            required_span = (count - 1) * min_gap_seconds
            if required_span <= day_window_seconds:
                start_offset = secrets.randbelow((day_window_seconds - required_span) + 1)
                offsets = [start_offset + (i * min_gap_seconds) for i in range(count)]
            else:
                self.timeline_overflow = True
                step = max(1, day_window_seconds // (count - 1))
                offsets = [min(day_window_seconds, i * step) for i in range(count)]

        for file_path, offset in zip(files, offsets):
            base_seconds = (8 * 3600) + offset
            hour = base_seconds // 3600
            minute = (base_seconds % 3600) // 60
            second = base_seconds % 60
            dt_local = datetime(
                self.target_date.year,
                self.target_date.month,
                self.target_date.day,
                hour, minute, second
            )
            self.path_timestamps[str(file_path)] = dt_local.timestamp()

    def _get_timestomp_timestamp(self, path):
        """Return the timestamp assigned to this path, keeping consistency across repeated writes."""
        if not self.target_date:
            return self.STANDARD_TIME
        key = str(path.resolve())
        ts = self.path_timestamps.get(key)
        if ts is not None:
            return ts
        # Fallback for newly-created/renamed paths not in the initial inventory.
        if self.path_timestamps:
            ts = max(self.path_timestamps.values())
        else:
            dt_local = datetime(self.target_date.year, self.target_date.month, self.target_date.day, 8, 0, 0)
            ts = dt_local.timestamp()
        self.path_timestamps[key] = ts
        return ts

    def _transfer_timestomp_timestamp(self, old_path, new_path):
        """Preserve assigned timestamp across renames."""
        if not self.target_date:
            return
        old_key = str(old_path.resolve())
        new_key = str(new_path.resolve())
        ts = self.path_timestamps.get(old_key)
        if ts is not None:
            self.path_timestamps[new_key] = ts

    def _normalize_exif_value(self, value):
        """Normalize exiftool values to deterministic comparable text."""
        if value is None:
            return ""
        if isinstance(value, (dict, list)):
            try:
                return json.dumps(value, sort_keys=True)
            except Exception:
                return str(value)
        return str(value).strip()

    def _is_sensitive_exif_tag(self, group, tag, value):
        """Heuristic to classify residual metadata tags that should be treated as traces."""
        group = (group or "").lower()
        tag = (tag or "").lower()
        value_norm = self._normalize_exif_value(value)
        if not value_norm:
            return False

        # Exclude non-sensitive filesystem/decoder/container bookkeeping.
        ignored_groups = {'file', 'system', 'composite', 'exiftool'}
        ignored_tags = {
            'filename', 'directory', 'filesize', 'filemodifydate', 'fileaccessdate',
            'fileinodechangedate', 'filepermissions', 'filetype', 'filetypeextension',
            'mimetype', 'imagewidth', 'imageheight', 'megapixels', 'bitdepth',
            'colorspace', 'encodingprocess', 'componentsconfiguration',
            'exiftoolversion', 'jfifversion', 'resolutionunit', 'xresolution', 'yresolution'
        }
        if group in ignored_groups or tag in ignored_tags:
            return False

        # QuickTime/HEIC has many structural codec tags that are not privacy metadata.
        if group == 'quicktime':
            quicktime_technical_keywords = (
                'brand', 'handler', 'spatialextent', 'pixeldepth', 'color',
                'primaries', 'transfer', 'matrix', 'fullrange', 'hevc',
                'profile', 'tier', 'compatibility', 'constraint', 'level',
                'segmentation', 'parallelism', 'chroma', 'bitdepth', 'framerate',
                'temporallayers', 'temporalid', 'mediadatasize', 'mediadataoffset',
                'rotation', 'aperture', 'lightlevel'
            )
            if any(k in tag for k in quicktime_technical_keywords):
                return False

        # ICC profile descriptors are generally color-management data, not user provenance.
        if group.startswith('icc'):
            return False

        # Strong signal groups that are metadata containers with provenance/user payload.
        suspicious_groups = {
            'xmp', 'iptc', 'photoshop', 'makernotes', 'exif',
            'ifd0', 'exififd', 'gps', 'keys', 'userdata', 'id3',
            'pdf', 'xml'
        }
        if group in suspicious_groups:
            return True

        # Keyword-based fallback for metadata semantics.
        sensitive_keywords = (
            'author', 'artist', 'creator', 'producer', 'software', 'tool',
            'owner', 'copyright', 'company', 'publisher', 'comment', 'description',
            'subject', 'title', 'keywords', 'album', 'composer', 'genre', 'by-line',
            'serial', 'model', 'make', 'lens', 'camera', 'history', 'documentid',
            'instanceid', 'originaldocumentid', 'uuid', 'uid', 'guid', 'gps',
            'location', 'city', 'state', 'country', 'address',
            'create', 'modify', 'metadata', 'profile'
        )
        return any(k in tag for k in sensitive_keywords)

    def _is_technical_exif_tag(self, group, tag):
        """Classify exif tags that are format/codec technical and should not affect score."""
        group = (group or "").lower()
        tag = (tag or "").lower()

        if group in {'file', 'system', 'composite', 'exiftool'}:
            return True
        if group.startswith('icc'):
            return True

        technical_tags = {
            'exiftoolversion', 'jfifversion', 'resolutionunit', 'xresolution', 'yresolution',
            'filename', 'directory', 'filesize', 'filemodifydate', 'fileaccessdate',
            'fileinodechangedate', 'filepermissions', 'filetype', 'filetypeextension', 'mimetype',
            'imagewidth', 'imageheight', 'megapixels'
        }
        if tag in technical_tags:
            return True

        if group == 'quicktime':
            return True
        return False

    def _should_run_binary_scan(self, path):
        """Limit binary trace scanning to formats where the signatures are meaningful."""
        suffix = path.suffix.lower()
        binary_like_suffixes = {
            '.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.webp', '.gif', '.bmp',
            '.mp4', '.mov', '.mkv', '.avi', '.mp3', '.wav', '.m4a',
            '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
            '.zip', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.tar.gz',
            '.db', '.sqlite', '.sqlite3'
        }
        if suffix in binary_like_suffixes:
            return True

        text_like_suffixes = {
            '.txt', '.md', '.rst', '.py', '.js', '.ts', '.java', '.c', '.cpp',
            '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.sh', '.zsh', '.bash',
            '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.csv',
            '.xml', '.html', '.css', '.sql', '.log'
        }
        if suffix in text_like_suffixes:
            return False

        return False

    def _obfuscate_process(self):
        """Phase 4: Multi-OS Process Obfuscation with Randomization."""
        try:
            names = [b"[kworker/u:1]", b"[ksoftirqd/0]", b"[migration/0]", b"[rcu_sched]", b"md", b"systemd"]
            if sys.platform == 'darwin':
                names = [b"com.apple.WindowServer", b"kernel_task", b"cfprefsd", b"distnoted"]
            
            name = secrets.choice(names)
            if sys.platform == 'linux':
                libc = ctypes.CDLL("libc.so.6")
                libc.prctl(15, name, 0, 0, 0)
            elif sys.platform == 'darwin':
                libc = ctypes.CDLL("/usr/lib/libc.dylib")
                libc.setprogname(name)
        except Exception:
            pass

    def _check_forensic_env(self):
        """Phase 6: Detects if running in a forensic/debug environment."""
        try:
            # Check for common debuggers/tracers
            if sys.platform == 'linux':
                if os.path.exists("/proc/self/status"):
                    status = open("/proc/self/status").read()
                    if "TracerPid:\t0" not in status:
                        return True
            elif sys.platform == 'darwin':
                # sysctl check for P_TRACED
                libc = ctypes.CDLL("/usr/lib/libc.dylib")
                # Structure for kinfo_proc is complex, use a simpler check if possible
                # or just return False for now to avoid complexity
                pass
        except Exception:
            pass
        return False

    def _lock_memory(self):
        """Phase 1: Anti-Forensic RAM protection."""
        try:
            if sys.platform == 'linux':
                libc = ctypes.CDLL("libc.so.6")
                # MCL_CURRENT=1, MCL_FUTURE=2
                libc.mlockall(3)
            elif sys.platform == 'darwin':
                libc = ctypes.CDLL("/usr/lib/libc.dylib")
                # macOS has mlockall in libc too
                libc.mlockall(3)
        except Exception:
            pass

    async def build_inventory(self):
        """Recursively finds all files."""
        print(f"[*] Scanning {self.root}...")
        all_files = [f for f in self.root.rglob('*') if f.is_file()]
        # Exclude this script itself unless self-destruct is explicitly requested
        script_path = pathlib.Path(__file__).resolve()
        if not self.force_self_destruct:
            all_files = [f for f in all_files if f.resolve() != script_path]
        self.file_list = all_files
        self._initialize_timeline_map()
        if self.timeline_overflow:
            print("[!] Warning: too many files for >=10 minute spacing in 08:00-20:00 window; closest possible spacing applied.")
        print(f"[+] Found {len(self.file_list)} targets.")

    def _get_wipe_passes(self):
        if self.wipe_mode == 'dod':
            return [b'\x00', b'\xff', 'random']
        elif self.wipe_mode == 'gutmann':
            # Simplified Gutmann or full 35 passes? 
            # Given the requirement "Masterpiece", let's stick to the spirit.
            # 4 random, 27 specific, 4 random.
            passes = ['random'] * 4
            specific = [b'\x55', b'\xaa', b'\x92\x49\x24', b'\x49\x24\x92', b'\x24\x92\x49',
                        b'\x00', b'\x11', b'\x22', b'\x33', b'\x44', b'\x55', b'\x66', b'\x77',
                        b'\x88', b'\x99', b'\xaa', b'\xbb', b'\xcc', b'\xdd', b'\xee', b'\xff',
                        b'\x92\x49\x24', b'\x49\x24\x92', b'\x24\x92\x49', b'\x6d\xb6\xdb', b'\xb6\xdb\x6d', b'\xdb\x6d\xb6']
            passes.extend(specific)
            passes.extend(['random'] * 4)
            return passes
        else: # nist or default
            return ['random']

    async def clean_config(self, path):
        """Phase 2: Generic text config sanitizer (.env, .conf, .ini)."""
        try:
            content = path.read_text(errors='ignore')
            lines = content.splitlines()
            new_lines = []
            
            # Sensitive patterns in configs
            sensitive = ['password', 'secret', 'key', 'token', 'auth', 'database', 'user', 'email']
            
            for line in lines:
                if '=' in line or ':' in line:
                    key = line.split('=')[0].split(':')[0].strip().lower()
                    if any(s in key for s in sensitive):
                        # Redact the value part
                        separator = '=' if '=' in line else ':'
                        parts = line.split(separator, 1)
                        new_lines.append(f"{parts[0]}{separator}[REDACTED]")
                    else:
                        new_lines.append(line)
                else:
                    new_lines.append(line)
            
            path.write_text('\n'.join(new_lines))
        except Exception:
            pass

    async def secure_overwrite(self, path):
        """Phase 1 & 4: Hardware-aware, buffered, multi-pass wiping with proper slack handling."""
        path = pathlib.Path(path).resolve()
        if not path.exists(): return
        
        # Use system 'shred' if available as it's highly optimized
        shred_path = shutil.which('shred')
        if shred_path:
            iterations = 3
            if self.wipe_mode == 'dod': iterations = 7
            elif self.wipe_mode == 'gutmann': iterations = 35
            try:
                subprocess.run([shred_path, '-u', '-n', str(iterations), str(path)], 
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except Exception:
                pass

        size = path.stat().st_size
        passes = self._get_wipe_passes()
        is_ssd = self._is_ssd(path)
        
        # Hardware-aware: If SSD and root, try blkdiscard (via a specialized range if possible)
        # For simplicity in this script, we'll use fallocate punch-hole which often triggers TRIM
        if is_ssd:
            try:
                # Punch hole to trigger TRIM/Discard
                subprocess.run(['fallocate', '-p', '-o', '0', '-l', str(size), str(path)], 
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass

        # Try O_DIRECT; if it fails due to alignment, fall back to O_SYNC writes
        fd = None
        try:
            # O_DIRECT requires block-aligned buffers. We'll use 4096.
            fd = os.open(path, os.O_RDWR | getattr(os, 'O_DIRECT', 0))
            for p_type in passes:
                os.lseek(fd, 0, os.SEEK_SET)
                remaining = size
                while remaining > 0:
                    chunk_size = min(65536, remaining)
                    # Align chunk_size for O_DIRECT if necessary (simplified)
                    if chunk_size % 4096 != 0 and remaining > 4096:
                        chunk_size = (chunk_size // 4096) * 4096
                    
                    data = os.urandom(chunk_size) if p_type == 'random' else (p_type * (chunk_size // len(p_type) + 1))[:chunk_size]
                    os.write(fd, data)
                    remaining -= chunk_size
                os.fsync(fd)
        except Exception:
            # Fallback path: O_SYNC to reduce cache effects
            if fd is not None:
                try: os.close(fd)
                except Exception: pass
            try:
                fd2 = os.open(path, os.O_RDWR | getattr(os, 'O_SYNC', 0))
                try:
                    for p_type in passes:
                        os.lseek(fd2, 0, os.SEEK_SET)
                        remaining = size
                        while remaining > 0:
                            chunk_size = min(65536, remaining)
                            data = os.urandom(chunk_size) if p_type == 'random' else (p_type * (chunk_size // len(p_type) + 1))[:chunk_size]
                            os.write(fd2, data)
                            remaining -= chunk_size
                        os.fsync(fd2)
                finally:
                    os.close(fd2)
            except Exception as e2:
                print(f"[!] Error wiping {path.name}: {e2}")
                return
        else:
            if fd is not None:
                try: os.close(fd)
                except Exception: pass
        
        # Slack Space Sanitization: extend to next cluster boundary then truncate back
        try:
            cluster = 4096
            pad_len = (cluster - (size % cluster)) % cluster
            if pad_len:
                with open(path, 'ab', buffering=0) as fpad:
                    fpad.write(os.urandom(pad_len))
                    fpad.flush(); os.fsync(fpad.fileno())
                with open(path, 'rb+') as ftr:
                    ftr.truncate(size)
                    ftr.flush(); os.fsync(ftr.fileno())
        except Exception:
            pass

    def _is_ssd(self, path):
        """Detects if the drive containing path is an SSD."""
        try:
            dev = os.stat(path).st_dev
            major = os.major(dev)
            minor = os.minor(dev)
            # Find the device name in /sys/dev/block/major:minor
            dev_link = f"/sys/dev/block/{major}:{minor}"
            if os.path.exists(dev_link):
                real_path = os.readlink(dev_link)
                # Check for rotational attribute
                rot_path = pathlib.Path(dev_link).resolve().parent / "queue/rotational"
                if not rot_path.exists():
                    # Might be a partition, go up one level
                    rot_path = pathlib.Path(dev_link).resolve().parent.parent / "queue/rotational"
                
                if rot_path.exists():
                    return rot_path.read_text().strip() == "0"
                
                # Check if it's NVMe
                if "nvme" in real_path:
                    return True
        except Exception:
            pass
        return False

    async def clean_image(self, path):
        """Phase 2: Advanced Image Normalization and Hash Mutation."""
        try:
            with Image.open(path) as img:
                # Optimized cleaning: just create a new image without info/exif
                clean_img = Image.new(img.mode, img.size)
                clean_img.paste(img)
                clean_img.info = {} # Explicitly wipe info dict
                
                # Hash Mutation: Bit-Flip (Phase 2)
                # Modify one non-visible pixel slightly
                pixel = list(clean_img.getpixel((0, 0)))
                pixel[0] = pixel[0] ^ 1
                clean_img.putpixel((0, 0), tuple(pixel))

                clean_img.save(path, format=img.format, optimize=True)
        except Exception as e:
            # Fallback to exiftool if Pillow fails
            await self.clean_exiftool(path)

    async def wipe_xattrs(self, path):
        """Removes macOS extended attributes and linux xattrs."""
        try:
            if os.name == 'posix':
                # Primary method: Python xattr API via os.*
                for attr in os.listxattr(path, follow_symlinks=False):
                    try:
                        os.removexattr(path, attr, follow_symlinks=False)
                    except Exception:
                        pass

                # Fallback commands by platform.
                if sys.platform == 'darwin':
                    subprocess.run(['xattr', '-c', str(path)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    xattr_bin = shutil.which('getfattr')
                    if xattr_bin and shutil.which('setfattr'):
                        out = subprocess.run(
                            [xattr_bin, '--absolute-names', '-d', str(path)],
                            capture_output=True, text=True
                        )
                        for line in out.stdout.splitlines():
                            line = line.strip()
                            if line.startswith('#') or '=' not in line:
                                continue
                            attr_name = line.split('=', 1)[0].strip()
                            subprocess.run(
                                ['setfattr', '-x', attr_name, str(path)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                            )
        except Exception:
            pass

    async def clean_sidecar_files(self, path):
        """Securely erases macOS sidecar files which contain folder metadata or UI settings."""
        sidecars = ['.DS_Store', '.localized', 'Icon\r', 'Thumbs.db', 'desktop.ini']
        if path.name in sidecars or path.name.startswith('._'):
            await self.secure_overwrite(path)
            try:
                os.remove(path)
            except Exception:
                pass
            return True
        return False

    async def clean_office(self, path):
        """Phase 2: Recursive XML sanitizer for Office/OpenDocument."""
        try:
            tmp_dir = tempfile.mkdtemp(dir=self.temp_base)
            with zipfile.ZipFile(path, 'r') as zip_ref:
                zip_ref.extractall(tmp_dir)
            
            # Files to strip
            to_strip = [
                'docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml',
                'docProps/thumbnail.jpeg', 'meta.xml', 'custom.xml', 'Thumbnails/thumbnail.png'
            ]
            
            for root, dirs, files in os.walk(tmp_dir):
                for file in files:
                    file_path = pathlib.Path(root) / file
                    rel_path = file_path.relative_to(tmp_dir)
                    
                    # Strip specific XMLs
                    if str(rel_path) in to_strip:
                        os.remove(file_path)
                        continue
                        
                    # Strip relationships that might contain absolute paths
                    if file.endswith('.rels'):
                        content = file_path.read_text(errors='ignore')
                        # Remove Target="file:///..." patterns
                        content = re.sub(r'Target="file:///[^"]+"', 'Target="stripped"', content)
                        file_path.write_text(content)
            
            # Rebuild archive
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zip_ref:
                for root, dirs, files in os.walk(tmp_dir):
                    for file in files:
                        file_path = pathlib.Path(root) / file
                        zip_ref.write(file_path, file_path.relative_to(tmp_dir))
            
            shutil.rmtree(tmp_dir)
        except Exception as e:
            pass

    async def clean_media(self, path):
        """Phase 2: FFmpeg pipeline for media metadata stripping."""
        try:
            temp_out_dir = tempfile.mkdtemp(dir=self.temp_base)
            out_path = pathlib.Path(temp_out_dir) / (path.name + ".tmp")
            
            # Enhanced FFmpeg pipeline: strip all streams except basic ones, and all metadata
            cmd = [
                'ffmpeg', '-y', '-i', str(path),
                '-map', '0:a?', '-map', '0:v?', # Only audio and video
                '-map_metadata', '-1',
                '-map_metadata:s:v', '-1',
                '-map_metadata:s:a', '-1',
                '-map_chapters', '-1',
                '-metadata', 'encoder=',
                '-metadata', 'creation_time=',
                '-c', 'copy',
                '-bitexact', # Force bit-exact output
                '-dn', # No data streams
                '-sn', # No subtitles
                str(out_path)
            ]
            process = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
            )
            await process.wait()
            if out_path.exists():
                shutil.copy2(out_path, path)
            
            shutil.rmtree(temp_out_dir)
        except Exception:
            pass

    async def clean_sqlite(self, path):
        """Phase 3: SQLite database vacuuming and free-list wiping."""
        try:
            conn = sqlite3.connect(path)
            cursor = conn.cursor()
            # Overwrite free-list pages with zeros before vacuuming
            cursor.execute("PRAGMA secure_delete = ON;")
            cursor.execute("PRAGMA journal_mode = DELETE;") # Ensure no WAL file remains
            cursor.execute("VACUUM;")
            conn.close()
            
            # Check for and wipe WAL/SHM files
            for side_suffix in ['-wal', '-shm', '-journal']:
                sidecar = path.parent / (path.name + side_suffix)
                if sidecar.exists():
                    await self.secure_overwrite(sidecar)
                    try: os.remove(sidecar)
                    except: pass
        except Exception:
            pass

    async def clean_json(self, path):
        """Phase 2: Deep JSON/HAR sanitizer for sensitive key-value pairs."""
        import json
        import gzip
        try:
            is_gz = path.suffix == '.gz' or path.name.endswith('.har.gz')
            if is_gz:
                with gzip.open(path, 'rt', encoding='utf-8', errors='ignore') as f:
                    data = json.load(f)
            else:
                with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                    data = json.load(f)
            
            # Sensitive keys to redact/remove
            sensitive_keys = [
                'cookie', 'set-cookie', 'authorization', 'cookie', 'password', 'passwd', 
                'token', 'access_token', 'refresh_token', 'session', 'sessionid', 
                'api_key', 'apikey', 'secret', 'client_id', 'client_secret', 'email',
                'user', 'username', 'login', 'bearer', 'signature', 'ip', 'ip_address',
                'set-cookie', 'x-auth-token', 'cf-ray', 'cookie'
            ]
            
            def scrub(obj):
                if isinstance(obj, dict):
                    for key in list(obj.keys()):
                        if any(s in key.lower() for s in sensitive_keys):
                            obj[key] = "[REDACTED]"
                        else:
                            scrub(obj[key])
                elif isinstance(obj, list):
                    for item in obj:
                        scrub(item)
            
            scrub(data)
            
            if is_gz:
                with gzip.open(path, 'wt', encoding='utf-8') as f:
                    json.dump(data, f)
            else:
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=2)
        except Exception:
            pass

    async def clean_exiftool(self, path):
        """Phase 2: Use exiftool for comprehensive masterpiece-level metadata stripping."""
        if not self.exiftool: return False
        try:
            cmd = [
                self.exiftool,
                '-overwrite_original',
                '-P',
                '-m',
                '-all=',
                '-XMP:all=',
                '-IPTC:all=',
                '-EXIF:all=',
                '-ICC_Profile:all=',
                '-Photoshop:all=',
                '-MakerNotes:all=',
                '-GPS:all=',
                '-QuickTime:all=',
                '-Keys:all=',
                '-ItemList:all=',
                '-UserData:all=',
                '-ThumbnailImage=',
                '-PreviewImage=',
                '-UserComment=',
                '-OwnerName=',
                '-SerialNumber=',
                str(path)
            ]
            proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if proc.returncode != 0:
                return False
            # A second pass catches format-specific leftovers in some containers.
            verify_cmd = [self.exiftool, '-overwrite_original', '-P', '-m', '-all=', str(path)]
            proc2 = subprocess.run(verify_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return proc2.returncode == 0
        except Exception:
            return False

    def _run_quiet(self, cmd, timeout=60):
        """Run a command quietly and return True on zero exit code."""
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=timeout
            )
            return proc.returncode == 0
        except Exception:
            return False

    def _has_xmp_tags(self, path):
        """Check if a file still contains XMP tags according to exiftool."""
        if not self.exiftool:
            return False
        try:
            cmd = [self.exiftool, '-j', '-s', '-XMP:all', str(path)]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            if proc.returncode != 0:
                return False
            payload = json.loads(proc.stdout)
            if not isinstance(payload, list) or not payload:
                return False
            tags = payload[0]
            # SourceFile is always present and is not metadata content.
            for key, value in tags.items():
                if key == 'SourceFile':
                    continue
                if self._normalize_exif_value(value):
                    return True
            return False
        except Exception:
            return False

    async def clean_heic(self, path):
        """HEIC-specific metadata scrubbing with re-encode fallbacks."""
        # First pass: normal exiftool removal.
        await self.clean_exiftool(path)
        if not self._has_xmp_tags(path):
            return True

        tmp_dir = tempfile.mkdtemp(dir=self.temp_base)
        try:
            stage_path = pathlib.Path(tmp_dir) / "stage.heic"
            current_path = pathlib.Path(path)

            # Attempt 1 (macOS): sips HEIC -> PNG -> HEIC to drop auxiliary metadata maps.
            sips_bin = shutil.which('sips') if sys.platform == 'darwin' else None
            if sips_bin:
                png_path = pathlib.Path(tmp_dir) / "stage.png"
                ok_in = self._run_quiet([sips_bin, '-s', 'format', 'png', str(current_path), '--out', str(png_path)], timeout=120)
                ok_out = False
                if ok_in and png_path.exists() and png_path.stat().st_size > 0:
                    ok_out = self._run_quiet([sips_bin, '-s', 'format', 'heic', str(png_path), '--out', str(stage_path)], timeout=120)
                if ok_out and stage_path.exists() and stage_path.stat().st_size > 0:
                    shutil.copy2(stage_path, current_path)
                    await self.clean_exiftool(current_path)
                    if not self._has_xmp_tags(current_path):
                        return True

            # Attempt 2: ImageMagick strip.
            magick_bin = shutil.which('magick')
            if magick_bin:
                if self._run_quiet([magick_bin, str(current_path), '-strip', str(stage_path)], timeout=120):
                    if stage_path.exists() and stage_path.stat().st_size > 0:
                        shutil.copy2(stage_path, current_path)
                        await self.clean_exiftool(current_path)
                        if not self._has_xmp_tags(current_path):
                            return True

            # Attempt 3: ffmpeg re-encode to HEIC with metadata disabled.
            ffmpeg_bin = shutil.which('ffmpeg')
            if ffmpeg_bin:
                ffmpeg_cmd = [
                    ffmpeg_bin, '-y', '-i', str(current_path),
                    '-map', '0:v:0',
                    '-map_metadata', '-1',
                    '-map_chapters', '-1',
                    '-dn', '-sn', '-an',
                    '-frames:v', '1',
                    '-c:v', 'libx265',
                    '-tag:v', 'hvc1',
                    '-pix_fmt', 'yuv420p',
                    '-f', 'heic',
                    str(stage_path)
                ]
                if self._run_quiet(ffmpeg_cmd, timeout=180):
                    if stage_path.exists() and stage_path.stat().st_size > 0:
                        shutil.copy2(stage_path, current_path)
                        await self.clean_exiftool(current_path)
                        if not self._has_xmp_tags(current_path):
                            return True

            return not self._has_xmp_tags(current_path)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    async def _inode_swap(self, path):
        """Phase 4: Force Inode Swap to break Spotlight/Metadata linkage on macOS."""
        if sys.platform != 'darwin' or not path.exists(): return path
        try:
            # Create a new file to get a fresh Inode, breaking Spotlight's history
            tmp_path = path.with_suffix(path.suffix + f'.{secrets.token_hex(4)}.tmp_swap')
            with path.open('rb') as f_in:
                with tmp_path.open('wb') as f_out:
                    shutil.copyfileobj(f_in, f_out)
            
            # Transfer basic permissions and perform atomic replacement
            stat_info = os.stat(path)
            os.chmod(tmp_path, stat_info.st_mode)
            path.unlink()
            tmp_path.rename(path)
            return path
        except Exception:
            return path

    async def _refresh_spotlight(self, path):
        """Force Spotlight to re-index the file to see it's clean."""
        if sys.platform != 'darwin' or not path.exists(): return
        try:
            subprocess.run(['mdimport', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except:
            pass

    async def clean_plist(self, path):
        """Phase 2: macOS Plist sanitizer."""
        import plistlib
        try:
            with open(path, 'rb') as f:
                data = plistlib.load(f)
            
            # Sensitive keys in plists
            sensitive = ['Path', 'URL', 'Host', 'User', 'Email', 'Token', 'Password', 'UUID']
            
            def scrub_plist(obj):
                if isinstance(obj, dict):
                    for k in list(obj.keys()):
                        if any(s in k for s in sensitive):
                            obj[k] = "[REDACTED]"
                        else:
                            scrub_plist(obj[k])
                elif isinstance(obj, list):
                    for i in obj:
                        scrub_plist(i)
            
            scrub_plist(data)
            with open(path, 'wb') as f:
                plistlib.dump(data, f)
        except Exception:
            pass

    async def clean_binary_generic(self, path):
        """Phase 5: Forensic scrubbing of unknown binary files for sensitive strings."""
        try:
            # We don't want to break the binary format, so we overwrite in-place with same length
            content = bytearray(path.read_bytes())
            
            # Common patterns to redact
            patterns = [
                rb'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', # Email
                rb'\b(?:\d{1,3}\.){3}\d{1,3}\b', # IPv4
                rb'/Users/[a-zA-Z0-9._-]+', # macOS paths
                rb'/home/[a-zA-Z0-9._-]+', # Linux paths
                rb'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b', # UUID
                rb'AKIA[0-9A-Z]{16}', # AWS Access Key ID
                rb'-----BEGIN [A-Z ]+ PRIVATE KEY-----', # Private Keys
                rb'AIza[0-9A-Za-z-_]{35}', # Google API Key
                rb'ghp_[a-zA-Z0-9]{36}', # GitHub PAT
                rb'xox[baprs]-[0-9a-zA-Z]{10,48}', # Slack Token
                rb'https?://[^\s<>"]+|www\.[^\s<>"]+', # URLs
                rb'(?:google|bing|duckduckgo)\.com/search\?q=[^&\s]+' # Search queries
            ]
            
            modified = False
            for pattern in patterns:
                for match in re.finditer(pattern, content):
                    start, end = match.span()
                    # Overwrite with dots or nulls to maintain length
                    # For private keys, we wipe the whole block if possible, but for now just the header
                    content[start:end] = b'.' * (end - start)
                    modified = True
            
            if modified:
                with open(path, 'wb') as f:
                    f.write(content)
        except Exception:
            pass

    async def clean_archive(self, path):
        """Phase 3: Recursive archive sanitization."""
        suffix = path.suffix.lower()
        if suffix == '.zip':
            await self._clean_zip(path)
        elif suffix in ['.tar', '.gz', '.bz2', '.xz', '.tgz', '.tar.gz']:
            await self._clean_tar(path)
        elif suffix == '.deb':
            await self._clean_deb(path)

    async def _clean_deb(self, path):
        """Specialize deb (ar archive) sanitization."""
        try:
            tmp_dir = tempfile.mkdtemp(dir=self.temp_base)
            # Unpack deb using ar
            subprocess.run(['ar', 'x', str(path.resolve())], cwd=tmp_dir, check=True)
            
            # deb typically contains control.tar.gz, data.tar.gz (and debian-binary)
            for f in pathlib.Path(tmp_dir).iterdir():
                if f.name.endswith('.tar.gz') or f.name.endswith('.tar.xz'):
                    await self._clean_tar(f)
            
            # Repack
            # ar -r path debian-binary control.tar.gz data.tar.gz
            files = ['debian-binary', 'control.tar.gz', 'data.tar.gz']
            # Re-order files as they were or standard
            cmd = ['ar', 'rc', str(path.resolve())] + [f for f in files if (pathlib.Path(tmp_dir)/f).exists()]
            subprocess.run(cmd, cwd=tmp_dir, check=True)
            
            shutil.rmtree(tmp_dir)
        except Exception:
            pass

    async def _clean_zip(self, path):
        try:
            tmp_dir = tempfile.mkdtemp(dir=self.temp_base)
            with zipfile.ZipFile(path, 'r') as z:
                z.extractall(tmp_dir)
            
            # Recurse and sanitize extracted files
            for root, dirs, files in os.walk(tmp_dir):
                for file in files:
                    await self.process_file(pathlib.Path(root) / file)
            
            # Re-archive
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
                for root, dirs, files in os.walk(tmp_dir):
                    for file in files:
                        fp = pathlib.Path(root) / file
                        z.write(fp, fp.relative_to(tmp_dir))
            shutil.rmtree(tmp_dir)
        except Exception:
            pass

    async def _clean_tar(self, path):
        try:
            tmp_dir = tempfile.mkdtemp(dir=self.temp_base)
            with tarfile.open(path, 'r:*') as t:
                t.extractall(tmp_dir)
            
            for root, dirs, files in os.walk(tmp_dir):
                for file in files:
                    await self.process_file(pathlib.Path(root) / file)
            
            mode = 'w:gz' if path.suffix == '.gz' else ('w:bz2' if path.suffix == '.bz2' else ('w:xz' if path.suffix == '.xz' else 'w'))
            with tarfile.open(path, mode) as t:
                t.add(tmp_dir, arcname='.')
            shutil.rmtree(tmp_dir)
        except Exception:
            pass

    async def clean_pdf(self, path):
        """Strips metadata and structural hidden data from PDFs."""
        if not pikepdf: return
        try:
            with pikepdf.open(path, allow_overwriting_input=True) as pdf:
                # 1. Remove obvious metadata and Info dictionary
                try: del pdf.Root.Metadata
                except: pass
                try: del pdf.docinfo
                except: pass

                # Explicitly clear the trailer Info dictionary
                try:
                    if hasattr(pdf, 'trailer') and pdf.trailer is not None:
                        if '/Info' in pdf.trailer:
                            del pdf.trailer['/Info']
                except: pass

                # 2. Remove structural metadata that often leaks info
                # Outlines (Bookmarks), PieceInfo (App data), Threads, etc.
                for key in ['/PieceInfo', '/Outlines', '/Threads', '/Names', '/OCProperties']:
                    try:
                        if key in pdf.Root:
                            del pdf.Root[key]
                    except: pass

                # 3. Deep clean pages (Thumbnails, Metadata, PieceInfo)
                for page in pdf.pages:
                    for key in ['/Metadata', '/PieceInfo', '/Thumb', '/Annots']:
                        try:
                            if key in page:
                                del page[key]
                        except: pass

                # 4. Enhanced: Remove forms, JavaScript, embedded files
                forensic_keys = [
                    '/AcroForm',      # Form fields with metadata
                    '/XFA',           # XFA forms
                    '/AA',            # Additional Actions (JavaScript)
                    '/OpenAction',    # Auto-run actions
                    '/EmbeddedFiles', # Attachments
                    '/Collection',    # Portfolio metadata
                    '/MarkInfo',      # Tagging structure info
                    '/StructTreeRoot',# Structure tree (accessibility)
                    '/PageLabels',    # Custom page labels
                    '/Lang',          # Language metadata
                    '/ViewerPreferences', # Viewer settings
                    '/SpiderInfo',    # Web capture info
                    '/Perms',         # Permissions signature
                    '/Legal',         # Legal attestations
                    '/Requirements',  # Extension requirements
                    '/OutputIntents', # Color profile metadata
                    '/AF'             # Associated files
                ]

                for key in forensic_keys:
                    try:
                        if key in pdf.Root:
                            del pdf.Root[key]
                    except: pass

                # 5. Remove metadata streams from all objects (including XMP streams)
                for obj in pdf.objects:
                    try:
                        if hasattr(obj, 'get') and callable(obj.get):
                            # Remove Metadata key from any object that has it
                            if '/Metadata' in obj:
                                del obj['/Metadata']
                            # Remove PieceInfo from any object
                            if '/PieceInfo' in obj:
                                del obj['/PieceInfo']

                            # Check if this is a stream object with XMP metadata
                            if hasattr(obj, 'Type') and obj.get('/Type') == '/Metadata':
                                # This is a metadata stream, try to remove it from references
                                try:
                                    obj_ref = pdf.get_object(obj.objgen)
                                    # Mark it for removal
                                except:
                                    pass

                            # Remove Info-like keys from any dictionary object
                            info_keys = ['/Author', '/Creator', '/Producer', '/Title',
                                       '/Subject', '/Keywords', '/CreationDate', '/ModDate',
                                       '/Trapped', '/CreatorTool']
                            for key in info_keys:
                                if key in obj:
                                    try:
                                        del obj[key]
                                    except:
                                        pass
                    except:
                        pass

                # 6. Remove page-level actions and metadata
                for page in pdf.pages:
                    page_forensic = ['/Metadata', '/PieceInfo', '/Thumb', '/Annots',
                                    '/AA', '/B', '/Dur', '/Trans', '/PresSteps']
                    for key in page_forensic:
                        try:
                            if key in page:
                                del page[key]
                        except: pass

                # 7. Remove unreferenced resources
                pdf.remove_unreferenced_resources()

                # 8. Save with static ID and linearization disabled
                # Linearization can contain timestamps and optimization metadata
                pdf.save(path, static_id=True, linearize=False,
                        compress_streams=True, recompress_flate=True)

            # 9. Force rewrite to eliminate incremental updates
            # Re-open and save again to ensure clean structure
            with pikepdf.open(path, allow_overwriting_input=True) as pdf2:
                pdf2.save(path, static_id=True, linearize=False)

            # 10. Binary-level scrubbing for any remaining text metadata
            await self._scrub_pdf_binary(path)
        except Exception as e:
            print(f"[!] PDF cleaning failed for {path.name}: {e}")

    async def _scrub_pdf_binary(self, path):
        """Binary-level scrubbing of PDF for remaining metadata strings."""
        try:
            content = bytearray(path.read_bytes())

            # Patterns to nullify in PDF binaries
            metadata_patterns = [
                # XMP metadata tags
                (rb'<xmp:[^>]+>[^<]*</xmp:[^>]+>', b''),
                (rb'<xmpMM:[^>]+>[^<]*</xmpMM:[^>]+>', b''),
                (rb'<dc:[^>]+>[^<]*</dc:[^>]+>', b''),
                (rb'<photoshop:[^>]+>[^<]*</photoshop:[^>]+>', b''),
                # PDF dictionary entries
                (rb'/Author\s*\([^)]*\)', b'/Author()'),
                (rb'/Creator\s*\([^)]*\)', b'/Creator()'),
                (rb'/Producer\s*\([^)]*\)', b'/Producer()'),
                (rb'/Title\s*\([^)]*\)', b'/Title()'),
                (rb'/Subject\s*\([^)]*\)', b'/Subject()'),
                (rb'/Keywords\s*\([^)]*\)', b'/Keywords()'),
                (rb'/CreationDate\s*\([^)]*\)', b''),
                (rb'/ModDate\s*\([^)]*\)', b''),
                # User paths
                (rb'/Users/[a-zA-Z0-9._/-]+', b'/tmp/user'),
                (rb'/home/[a-zA-Z0-9._/-]+', b'/tmp/user'),
                (rb'C:\\Users\\[a-zA-Z0-9._\\-]+', b'C:\\tmp\\user'),
            ]

            modified = False
            for pattern, replacement in metadata_patterns:
                matches = list(re.finditer(pattern, content))
                # Replace from end to start to maintain indices
                for match in reversed(matches):
                    start, end = match.span()
                    # Replace with spaces to maintain PDF structure
                    content[start:end] = replacement + b' ' * (end - start - len(replacement))
                    modified = True

            if modified:
                path.write_bytes(content)
        except Exception:
            pass

    async def rename_dance(self, path):
        """Phase 3: Rename Dance to overwrite directory entries."""
        if not self.rename:
            return path
            
        current_path = path
        try:
            parent = current_path.parent
            # Increased iterations for even more obfuscation (Phase 3+)
            for i in range(1, 26):
                new_name = secrets.token_hex(i * 2)
                new_path = current_path.with_name(new_name)
                current_path.rename(new_path)
                # fsync directory to force metadata persistence
                try:
                    dfd = os.open(str(parent), os.O_RDONLY)
                    os.fsync(dfd)
                    os.close(dfd)
                except Exception:
                    pass
                current_path = new_path
            
            # Final Entropy-Based Renaming (UUID4)
            final_path = current_path.with_name(str(uuid.uuid4()))
            current_path.rename(final_path)
            try:
                dfd = os.open(str(parent), os.O_RDONLY)
                os.fsync(dfd)
                os.close(dfd)
            except Exception:
                pass
            return final_path
        except Exception:
            return current_path

    async def timestomp(self, path):
        """Phase 2: TIMESTOMP - Set all 4 timestamps to standard system values and clear flags/ACLs."""
        try:
            path_str = str(path)
            target_time = self._get_timestomp_timestamp(path)
            
            # 1. Clear macOS flags & ACLs
            if sys.platform == 'darwin':
                # Clear all flags (hidden, uchg, etc.)
                subprocess.run(['chflags', '0', path_str], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                # Remove ACLs
                subprocess.run(['chmod', '-N', path_str], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # 2. Normalize permissions (0644 for files, 0755 for dirs)
            if path.is_file():
                os.chmod(path, 0o644)
            else:
                os.chmod(path, 0o755)

            # 3. Set standard timestamps (atime, mtime)
            # On macOS APFS, backdating mtime usually backdates birthtime too.
            os.utime(path, (target_time, target_time))

            # 4. Expert: Explicit Birthtime (Creation Time) via setattrlist on macOS
            if sys.platform == 'darwin':
                self._macos_set_birthtime(path_str, target_time)

        except Exception:
            pass

    def _macos_set_birthtime(self, path, timestamp):
        """Low-level call to set ATTR_CMN_CRTIME (Birthtime) on macOS."""
        try:
            libc = ctypes.CDLL("/usr/lib/libc.dylib")
            
            # attrlist structure
            # bitmapcount, reserved, commonattr, volattr, dirattr, fileattr, forkattr
            attr_bitmap = 0x00000100 # ATTR_CMN_CRTIME
            attrlist = struct.pack("HHIIIII", 5, 0, attr_bitmap, 0, 0, 0, 0)
            
            # Timespec: tv_sec (long), tv_nsec (long)
            timespec = struct.pack("ll", int(timestamp), 0)
            
            # setattrlist(path, attrlist, buffer, buffersize, options)
            # FSOPT_NOFOLLOW = 0x0001
            libc.setattrlist(path.encode(), attrlist, timespec, len(timespec), 0x0001)
        except Exception:
            pass

    async def scrub_filesystem_traces(self):
        """Wipes metadata from all parent directories in the target tree."""
        print("[*] Scrubbing filesystem directory traces...")
        all_dirs = set()
        for f in self.file_list:
            # Collect all parents up to the root
            for parent in f.parents:
                if self.root in parent.parents or parent == self.root:
                    all_dirs.add(parent)
        
        # Sort by depth descending (deepest first)
        sorted_dirs = sorted(list(all_dirs), key=lambda x: len(x.parts), reverse=True)
        for d in sorted_dirs:
            await self.timestomp(d)

    async def sync(self):
        """Force filesystem sync and metadata flush."""
        try:
            os.sync()
        except Exception:
            pass

    def get_mime_type(self, path):
        if self.mime:
            try: return self.mime.from_file(str(path))
            except: pass
        
        # Fallback to system 'file' command
        try:
            result = subprocess.run(['file', '--mime-type', '-b', str(path)], 
                                    capture_output=True, text=True)
            if result.returncode == 0:
                return result.stdout.strip()
        except:
            pass

        # Final fallback to mimetypes
        mime, _ = mimetypes.guess_type(str(path))
        return mime

    async def verify_remaining_metadata(self, path):
        """Deep verification of remaining metadata after cleaning."""
        if not path.exists():
            return None

        result = {
            'file': path.name,
            'path': str(path),
            'exiftool': {},
            'technical_exiftool': {},
            'pdf_structure': {},
            'xattrs': [],
            'sidecars': [],
            'binary_traces': [],
            'total_traces': 0
        }

        # Layer 0: Filesystem-level metadata (xattrs + sidecars)
        try:
            xattrs = os.listxattr(path, follow_symlinks=False)
            # Keep all xattrs except known neutral Linux capability marker.
            neutral = {'security.capability'}
            suspicious = [x for x in xattrs if x not in neutral]
            if suspicious:
                result['xattrs'] = suspicious
                result['total_traces'] += len(suspicious)
        except Exception:
            pass

        sidecar_candidates = [
            path.parent / f"._{path.name}",
            path.parent / ".DS_Store",
            path.parent / "Thumbs.db",
            path.parent / "desktop.ini"
        ]
        for candidate in sidecar_candidates:
            try:
                if candidate.exists():
                    result['sidecars'].append(candidate.name)
                    result['total_traces'] += 1
            except Exception:
                pass

        # Layer 1: ExifTool deep scan
        if self.exiftool:
            try:
                cmd = [self.exiftool, '-j', '-a', '-G1', '-s', str(path)]
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                if proc.returncode == 0:
                    parsed = json.loads(proc.stdout)
                    if isinstance(parsed, list) and parsed:
                        tags = parsed[0]
                        for raw_key, raw_val in tags.items():
                            key = str(raw_key)
                            if key == 'SourceFile':
                                continue
                            group, tag = ('', key)
                            if ':' in key:
                                group, tag = key.split(':', 1)
                            value = self._normalize_exif_value(raw_val)
                            show_key = f"[{group}] {tag}" if group else tag
                            if self._is_sensitive_exif_tag(group, tag, value):
                                result['exiftool'][show_key] = value
                                result['total_traces'] += 1
                            elif self._is_technical_exif_tag(group, tag):
                                result['technical_exiftool'][show_key] = value
            except Exception:
                pass

        # Layer 2: PDF-specific deep inspection
        if pikepdf and path.suffix.lower() == '.pdf':
            try:
                with pikepdf.open(path) as pdf:
                    pdf_meta = {}

                    # Check Root dictionary
                    suspicious_keys = ['/Metadata', '/Info', '/AcroForm', '/XFA', '/AA',
                                      '/EmbeddedFiles', '/MarkInfo', '/StructTreeRoot']
                    root_keys = []
                    for key in suspicious_keys:
                        if key in pdf.Root:
                            root_keys.append(key)
                            result['total_traces'] += 1

                    if root_keys:
                        pdf_meta['root_suspicious_keys'] = root_keys

                    # Check trailer Info
                    if hasattr(pdf, 'trailer') and pdf.trailer and '/Info' in pdf.trailer:
                        pdf_meta['trailer_info'] = 'FOUND'
                        result['total_traces'] += 1

                    # Check docinfo
                    try:
                        if pdf.docinfo:
                            info_dict = {}
                            for key in ['/Author', '/Creator', '/Producer', '/Title',
                                       '/Subject', '/Keywords', '/CreationDate', '/ModDate']:
                                if key in pdf.docinfo:
                                    val = str(pdf.docinfo[key])
                                    if val and val.strip():
                                        info_dict[key] = val
                                        result['total_traces'] += 1
                            if info_dict:
                                pdf_meta['docinfo'] = info_dict
                    except:
                        pass

                    # Scan for XMP metadata streams
                    xmp_streams = []
                    for i, obj in enumerate(pdf.objects):
                        try:
                            if hasattr(obj, 'get') and obj.get('/Type') == '/Metadata':
                                xmp_streams.append(f'Object_{i}')
                                result['total_traces'] += 1
                        except:
                            pass

                    if xmp_streams:
                        pdf_meta['xmp_streams'] = xmp_streams

                    if pdf_meta:
                        result['pdf_structure'] = pdf_meta
            except Exception:
                pass

        # Layer 3: Binary-level pattern detection
        # Restrict this to binary formats to avoid false positives in normal text/code files.
        if self._should_run_binary_scan(path):
            try:
                content = path.read_bytes()

                # Critical patterns with context extraction
                patterns = [
                    (rb'/Author\s*\([^)]+\)', 'PDF_Author'),
                    (rb'/Creator\s*\([^)]+\)', 'PDF_Creator'),
                    (rb'/Producer\s*\([^)]+\)', 'PDF_Producer'),
                    (rb'/CreationDate\s*\(D:[^)]+\)', 'PDF_CreationDate'),
                    (rb'/ModDate\s*\(D:[^)]+\)', 'PDF_ModDate'),
                    (rb'<xmp:[^>]+>[^<]+</xmp:[^>]+>', 'XMP_Metadata'),
                    (rb'<xmpMM:[^>]+>[^<]+</xmpMM:[^>]+>', 'XMP_MediaManagement'),
                    (rb'<dc:[^>]+>[^<]+</dc:[^>]+>', 'XMP_DublinCore'),
                    (rb'<rdf:Description[^>]*>', 'XMP_RDFDescription'),
                    (rb'xmlns:xmp=', 'XMP_XMLNS'),
                    (rb'DocumentID[^<]+', 'DocumentID'),
                    (rb'InstanceID[^<]+', 'InstanceID'),
                    (rb'OriginalDocumentID[^<]+', 'OriginalDocumentID'),
                    (rb'/Users/[a-zA-Z0-9._/-]{5,}', 'UserPath_Mac'),
                    (rb'/home/[a-zA-Z0-9._/-]{5,}', 'UserPath_Linux'),
                    (rb'C:\\Users\\[a-zA-Z0-9._\\-]{5,}', 'UserPath_Windows'),
                    (rb'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', 'Email'),
                ]

                for pattern, name in patterns:
                    matches = re.finditer(pattern, content)
                    for match in matches:
                        pos = match.start()
                        matched_text = match.group()[:100]  # Limit to 100 bytes
                        try:
                            matched_str = matched_text.decode('latin1')
                        except:
                            matched_str = str(matched_text)

                        result['binary_traces'].append({
                            'type': name,
                            'offset': pos,
                            'sample': matched_str
                        })
                        result['total_traces'] += 1

                        # Limit to first 2 matches per pattern to avoid overcount inflation
                        if len([t for t in result['binary_traces'] if t['type'] == name]) >= 2:
                            break
            except Exception:
                pass

        return result

    async def print_verification_report(self, verification_results):
        """Print detailed verification report."""
        print("\n" + "="*70)
        print("POST-CLEANING METADATA VERIFICATION REPORT")
        print("="*70)

        files_with_metadata = [r for r in verification_results if r and r['total_traces'] > 0]

        if not files_with_metadata:
            print("\n✓ NO METADATA FOUND - Perfect 100/100 Cleanliness!")
            print("="*70)
            return

        for result in files_with_metadata:
            print(f"\nFile: {result['file']}")
            print("─" * 70)

            # ExifTool findings
            if result['exiftool']:
                print("├─ ExifTool Analysis:")
                for tag, value in result['exiftool'].items():
                    # Truncate long values
                    val_display = value[:60] + '...' if len(value) > 60 else value
                    print(f"│  └─ {tag}: {val_display} ❌")

            if result['technical_exiftool']:
                print(f"├─ Technical Container Tags (not scored): {len(result['technical_exiftool'])}")

            if result['xattrs']:
                print("├─ Extended Attributes:")
                for attr in result['xattrs']:
                    print(f"│  └─ {attr} ❌")

            if result['sidecars']:
                print("├─ Sidecar Metadata Files:")
                for sidecar in result['sidecars']:
                    print(f"│  └─ {sidecar} ❌")

            # PDF structure findings
            if result['pdf_structure']:
                print("├─ PDF Structure Analysis:")
                pdf_meta = result['pdf_structure']

                if 'root_suspicious_keys' in pdf_meta:
                    print(f"│  └─ Root Keys Found: {pdf_meta['root_suspicious_keys']} ❌")

                if 'trailer_info' in pdf_meta:
                    print(f"│  └─ Trailer Info Dictionary: {pdf_meta['trailer_info']} ❌")

                if 'docinfo' in pdf_meta:
                    print("│  └─ DocInfo Dictionary:")
                    for key, val in pdf_meta['docinfo'].items():
                        val_display = val[:40] + '...' if len(val) > 40 else val
                        print(f"│     └─ {key}: {val_display} ❌")

                if 'xmp_streams' in pdf_meta:
                    print(f"│  └─ XMP Metadata Streams: {pdf_meta['xmp_streams']} ❌")

            # Binary traces
            if result['binary_traces']:
                print("├─ Binary Scan Results:")
                # Group by type
                by_type = {}
                for trace in result['binary_traces']:
                    t = trace['type']
                    if t not in by_type:
                        by_type[t] = []
                    by_type[t].append(trace)

                for trace_type, traces in by_type.items():
                    print(f"│  └─ {trace_type}: {len(traces)} occurrence(s)")
                    for trace in traces[:2]:  # Show first 2 samples
                        sample = trace['sample'][:50]
                        print(f"│     └─ [Offset {trace['offset']}] {sample} ❌")

            print(f"└─ Total Traces: {result['total_traces']}")

        # Summary
        total_files_scanned = len(verification_results)
        total_files_dirty = len(files_with_metadata)
        total_traces = sum(r['total_traces'] for r in files_with_metadata)

        print("\n" + "="*70)
        print(f"Summary: {total_files_dirty}/{total_files_scanned} files contain metadata")
        print(f"Total Metadata Traces: {total_traces}")
        print("="*70 + "\n")

    def calculate_cleanliness_score(self, verification_results, audit_results, deep_verification_enabled):
        """Score based on deep verification; avoid inflated 100/100 on partial checks."""
        if deep_verification_enabled and verification_results:
            total_files = len(verification_results)
            dirty_files = sum(1 for r in verification_results if r and r['total_traces'] > 0)
            total_traces = sum((r['total_traces'] for r in verification_results if r), 0)

            # Weighted traces to reduce false-low scores from many low-value detections.
            weighted_traces = 0.0
            for r in verification_results:
                if not r:
                    continue
                exif_count = len(r.get('exiftool', {}))
                xattr_count = len(r.get('xattrs', []))
                sidecar_count = len(r.get('sidecars', []))
                pdf_count = 0
                if r.get('pdf_structure'):
                    for v in r['pdf_structure'].values():
                        if isinstance(v, list):
                            pdf_count += len(v)
                        elif isinstance(v, dict):
                            pdf_count += len(v)
                        else:
                            pdf_count += 1
                binary_unique_types = len(set(t.get('type') for t in r.get('binary_traces', []) if t.get('type')))

                weighted_traces += min(8, exif_count) * 1.0
                weighted_traces += min(4, xattr_count) * 2.0
                weighted_traces += min(3, sidecar_count) * 2.5
                weighted_traces += min(6, pdf_count) * 1.5
                weighted_traces += min(4, binary_unique_types) * 1.25

            dirty_ratio = dirty_files / total_files if total_files else 0.0
            weighted_density = weighted_traces / total_files if total_files else 0.0
            penalty = (dirty_ratio * 62.0) + min(34.0, weighted_density * 4.5)
            score = max(0, round(100 - penalty))

            if total_traces > 0 and score == 100:
                score = 99

            # Without exiftool the scan is less comprehensive; avoid false perfect score.
            if not self.exiftool:
                score = min(score, 85)
            return score, total_traces, dirty_files, total_files

        # Fallback for delete mode or when verification cannot run.
        total_traces = sum(audit_results)
        base_score = max(0, 100 - total_traces)
        # Cap fallback score because only lightweight signatures were checked.
        score = min(base_score, 70)
        return score, total_traces, None, None

    async def audit_file(self, path):
        """Phase 6: Smart audit for critical metadata signatures only."""
        if not path.exists(): return 0
        try:
            content = path.read_bytes()
            found = 0
            found_sigs = []

            # CRITICAL signatures only - actual metadata that leaks info
            critical_sigs = [
                b'/Author', b'/Creator', b'/Producer',
                b'/CreationDate', b'/ModDate',
                b'<xmp:', b'<xmpMM:', b'<dc:', b'<photoshop:',
                b'DocumentID', b'InstanceID', b'OriginalDocumentID'
            ]

            for sig in critical_sigs:
                if sig in content:
                    found += 1
                    found_sigs.append(sig.decode(errors='ignore'))

            # Check for real user path traces (not in comments or URLs)
            user_patterns = [b'/Users/', b'/home/', b'C:\\Users\\']
            for pat in user_patterns:
                matches = 0
                idx = 0
                while True:
                    idx = content.find(pat, idx)
                    if idx == -1:
                        break
                    # Check context - avoid false positives
                    context = content[max(0, idx-20):idx+50]
                    if b'http' not in context and b'.com' not in context and b'www' not in context:
                        # Check if it looks like a real path (has more directory structure)
                        if b'/' in content[idx+len(pat):idx+len(pat)+20] or b'\\' in content[idx+len(pat):idx+len(pat)+20]:
                            matches += 1
                            break  # Count once per pattern
                    idx += 1

                if matches > 0:
                    found += 1
                    found_sigs.append(f"PathTrace({pat.decode(errors='ignore')})")

            # Only check for MAC addresses in metadata context
            mac_matches = re.finditer(rb'([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})', content)
            for match in mac_matches:
                # Check if near metadata keywords
                pos = match.start()
                context = content[max(0, pos-50):pos+50]
                if b'Author' in context or b'Creator' in context or b'Producer' in context:
                    found += 1
                    found_sigs.append("MAC_Address")
                    break

            # Check for actual metadata timestamps (in XML/XMP context)
            timestamp_matches = re.finditer(rb'20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}', content)
            for match in timestamp_matches:
                pos = match.start()
                context = content[max(0, pos-100):pos+20]
                # Only count if in metadata context
                if b'Date' in context or b'Time' in context or b'xmp' in context or b'Created' in context:
                    found += 1
                    found_sigs.append("ISO_Timestamp")
                    break

            if found > 0:
                print(f"[!] Found {found} traces in {path.name}: {', '.join(found_sigs)}")
            return found
        except Exception:
            return 0

    async def process_file(self, path):
        """Main dispatcher."""
        # Phase 1: Wipe extended attributes for ALL files
        await self.wipe_xattrs(path)

        # Special handling for system metadata files
        if await self.clean_sidecar_files(path):
            return 1

        # Phase 2: Use exiftool if available (most powerful general cleaner)
        await self.clean_exiftool(path)

        mime_type = self.get_mime_type(path)
        suffix = path.suffix.lower()

        processed = False
        # Phase 2 & 3: Sanitization
        if (mime_type and mime_type.startswith('image/')) or suffix in ['.jpg', '.jpeg', '.png', '.tiff', '.webp', '.gif', '.bmp']:
            if suffix in ['.heic', '.heif']:
                await self.clean_heic(path)
            else:
                await self.clean_image(path)
            processed = True
        elif mime_type == 'application/pdf' or suffix == '.pdf':
            await self.clean_pdf(path)
            processed = True
        elif suffix in ['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']:
            await self.clean_office(path)
            processed = True
        elif (mime_type and (mime_type.startswith('video/') or mime_type.startswith('audio/'))) or suffix in ['.mp4', '.mkv', '.mp3', '.wav', '.mov', '.avi']:
            await self.clean_media(path)
            processed = True
        elif suffix in ['.db', '.sqlite', '.sqlite3']:
            await self.clean_sqlite(path)
            processed = True
        elif suffix in ['.zip', '.tar', '.gz', '.bz2', '.xz', '.deb', '.tar.gz', '.tgz', '.apk', '.jar', '.ipa', '.whl', '.egg']:
            await self.clean_archive(path)
            processed = True
        elif suffix in ['.har', '.json', '.har.gz']:
            await self.clean_json(path)
            processed = True
        elif suffix in ['.plist']:
            await self.clean_plist(path)
            processed = True
        elif suffix in ['.env', '.conf', '.ini', '.cfg', '.yaml', '.yml']:
            await self.clean_config(path)
            processed = True

        # Phase 5: Generic scrubbing for everything else or even already processed files
        # This ensures strings that survived format-specific cleaning are caught
        await self.clean_binary_generic(path)
        
        # Phase 4 (Enhanced): Inode Swap for macOS
        path = await self._inode_swap(path)
        
        # Phase 6: Audit before final destruction
        traces = await self.audit_file(path)
        
        # Phase 3: Filesystem Anonymization
        # ONLY if rename is enabled
        if self.rename:
            old_path = path
            path = await self.rename_dance(path)
            self._transfer_timestomp_timestamp(old_path, path)
        
        await self.timestomp(path)
        
        # Phase 4: Final Wiping before deletion
        if self.delete_files:
            await self.secure_overwrite(path)
            os.remove(path)
        
        return traces

    async def _sem_task(self, sem, path):
        async with sem:
            return await self.process_file(path)

    async def execute(self):
        await self.build_inventory()
        if not self.file_list:
            print("[!] No files found to process.")
            if self.force_self_destruct:
                self.self_destruct()
            return

        print("[*] Processing and Performing Forensic Audit...")
        
        sem = asyncio.Semaphore(8)
        tasks = [self._sem_task(sem, f) for f in self.file_list]
        results = await asyncio.gather(*tasks)
        
        # Phase 7: Deep Metadata Scrubbing (New)
        await self.scrub_filesystem_traces()
        
        # Final batch sync to align all ctimes
        print("[*] Finalizing temporal consistency...")
        all_to_sync = []
        for f in self.file_list:
            if f.exists(): all_to_sync.append(f)
        
        # Also sync all parent directories in the tree
        all_dirs = set()
        for f in self.file_list:
            for parent in f.parents:
                if self.root in parent.parents or parent == self.root:
                    all_dirs.add(parent)
        all_to_sync.extend(list(all_dirs))
        
        # Tight loop to ensure near-identical ctimes
        for item in all_to_sync:
            if item.exists():
                await self.timestomp(item)
                # Phase 2 (Enhanced): Spotlight Refresh after final timestomp
                await self._refresh_spotlight(item)
        
        await self.sync()

        # Post-Cleaning Metadata Verification (only if files not deleted)
        verification_results = []
        deep_verification_enabled = False
        if not self.delete_files:
            print("[*] Running post-cleaning metadata verification...")
            deep_verification_enabled = True
            for f in self.file_list:
                if f.exists():
                    result = await self.verify_remaining_metadata(f)
                    if result:
                        verification_results.append(result)

            # Print detailed verification report
            await self.print_verification_report(verification_results)

        # Calculate Cleanliness Score using deep verification when available.
        score, total_traces, dirty_files, total_files = self.calculate_cleanliness_score(
            verification_results=verification_results,
            audit_results=results,
            deep_verification_enabled=deep_verification_enabled
        )

        print(f"[+] Forensic Cleanliness Score: {score}/100")
        if deep_verification_enabled and total_files is not None:
            print(f"[*] Score basis: {dirty_files}/{total_files} files with metadata, {total_traces} total traces.")
            if score == 100:
                print("[*] 100/100 assigned only because deep verification found zero traces.")
        else:
            print("[*] Score basis: lightweight audit only (deep verification unavailable in delete mode).")
        if self.delete_files:
            print("[!] All files disinfected, anonymized, and securely erased.")
        else:
            print("[+] All files disinfected and anonymized.")

        if self.force_self_destruct:
            self.self_destruct()

        if self.clean_history_mode:
            self.clean_history()

    def clean_history(self):
        """Phase 5: Log & History Eradication."""
        print("[*] Eradicating system traces and command history...")
        history_files = [
            '~/.bash_history', '~/.python_history', '~/.zprofile', 
            '~/.zsh_history', '~/.bash_logout', '~/.sh_history',
            '~/.lesshst', '~/.viminfo', '~/.sqlite_history', '~/.mysql_history',
            '~/.psql_history', '~/.node_repl_history', '~/.bash_sessions/*'
        ]
        
        # macOS specific cache clearing
        if sys.platform == 'darwin':
            # 1. QuickLook cache
            try:
                subprocess.run(['qlmanage', '-r', 'cache'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except: pass
            
            # 2. System Logs (ASL)
            try:
                subprocess.run(['sudo', '-n', 'rm', '-rf', '/var/log/asl/*.asl'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except: pass
            
            # 3. Securely wipe user-level caches
            try:
                cache_path = pathlib.Path('~/Library/Caches').expanduser()
                # We don't delete everything as it might break apps, but we can clear specific forensic-heavy ones
                forensic_caches = ['com.apple.Safari', 'Metadata/Library/Caches', 'CloudKit']
                for fc in forensic_caches:
                    p = cache_path / fc
                    if p.exists():
                        subprocess.run(['rm', '-rf', str(p)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except: pass

        for hf_pattern in history_files:
            try:
                base_path = pathlib.Path(hf_pattern.replace('*', '')).expanduser()
                if '*' in hf_pattern:
                    targets = list(base_path.parent.glob(base_path.name + '*'))
                else:
                    targets = [base_path]
                
                for p in targets:
                    if p.exists():
                        if p.is_file():
                            lines = p.read_text(errors='ignore').splitlines()
                            # Replace lines containing wiper_venom with harmless 'cd .'
                            new_lines = ['cd .' if 'wiper_venom' in l else l for l in lines]
                            p.write_text('\n'.join(new_lines[-1000:]))
                        elif p.is_dir():
                            shutil.rmtree(p)
            except Exception:
                pass
        
        # System-wide log scrubbing (Phase 4)
        if sys.platform == 'linux':
            try:
                subprocess.run(['journalctl', '--vacuum-time=1s'], 
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass

        # Windows-specific cleanup (if running on Windows/Wine)
        if os.name == 'nt':
            try:
                # Clear Recent Items / Jump Lists
                recent = pathlib.Path(os.environ.get('APPDATA', '')) / 'Microsoft/Windows/Recent/AutomaticDestinations'
                if recent.exists():
                    for f in recent.glob('*'): f.unlink()
            except: pass

    def _wipe_os_caches(self):
        """Drops filesystem caches if running with sufficient privileges."""
        try:
            os.sync()
            if os.geteuid() == 0:
                with open('/proc/sys/vm/drop_caches', 'w') as f:
                    f.write('3')
        except Exception:
            pass

    def _secure_self_wipe(self):
        """Multi-pass wipe of the script file itself."""
        try:
            script_path = pathlib.Path(__file__).resolve()
            size = script_path.stat().st_size
            passes = self._get_wipe_passes()
            
            with open(script_path, "rb+") as f:
                for p_type in passes:
                    f.seek(0)
                    remaining = size
                    while remaining > 0:
                        chunk_size = min(65536, remaining)
                        data = os.urandom(chunk_size) if p_type == 'random' else (p_type * (chunk_size // len(p_type) + 1))[:chunk_size]
                        f.write(data)
                        remaining -= chunk_size
                    f.flush()
                    os.fsync(f.fileno())
            os.remove(script_path)
        except Exception:
            pass

    def self_destruct(self):
        """
        Consolidated destructive task suite. 
        Triggered ONLY when -f is present.
        """
        print("[*] Initiating Total Eradication sequence...")
        
        # 1. System OS Cache Wiping
        self._wipe_os_caches()
        
        # 2. Script Self-Wipe
        self._secure_self_wipe()
        
        # 4. Final Kernel Sync & Exit
        os.sync()
        print("[+] Self-destruct complete. Ghost mode active.")
        os._exit(0)

if __name__ == "__main__":
    banner = """
    \033[91m██╗    ██╗██╗██████╗ ███████╗██████╗     ██╗   ██╗███████╗███╗   ██╗ ██████╗ ███╗   ███╗
    ██║    ██║██║██╔══██╗██╔════╝██╔══██╗    ██║   ██║██╔════╝████╗  ██║██╔═══██╗████╗ ████║
    ██║ █╗ ██║██║██████╔╝█████╗  ██████╔╝    ██║   ██║█████╗  ██╔██╗ ██║██║   ██║██╔████╔██║
    ██║███╗██║██║██╔═══╝ ██╔══╝  ██╔══██╗    ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║██║   ██║██║╚██╔╝██║
    ╚███╔███╔╝██║██║     ███████╗██║  ██║     ╚████╔╝ ███████╗██║ ╚████║╚██████╔╝██║ ╚═╝ ██║
     ╚══╝╚══╝ ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝      ╚═══╝  ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝     ╚═╝\033[0m
                      \033[93mv3.0 [ULTIMATE FORENSIC DATA WIPER MASTERPIECE]\033[0m
    """
    print(banner)
    parser = argparse.ArgumentParser(description="Wiper Venom: Forensic Anonymization Suite [Masterpiece Edition]")
    parser.add_argument("-p", "--dir", default=os.getcwd(), help="Target directory")
    parser.add_argument("-d", "--delete", action="store_true", help="Enable secure overwrite and file deletion")
    parser.add_argument("-f", "--force", action="store_true", help="Enable self-destruct sequence")
    parser.add_argument("-c", "--clean", action="store_true", help="Enable system history and cache eradication")
    parser.add_argument("-r", "--rename", action="store_true", help="Enable aggressive file renaming (obfuscation)")
    parser.add_argument("-m", "--mode", choices=['nist', 'dod', 'gutmann'], default='nist', help="Wiping mode")
    parser.add_argument("-date", "--date", dest="target_date", help="Timestomp date in DD/MM/YYYY (random local time between 08:00 and 20:59)")
    args = parser.parse_args()

    parsed_date = None
    if args.target_date:
        try:
            parsed_date = datetime.strptime(args.target_date, "%d/%m/%Y").date()
        except ValueError:
            print("[!] Invalid -date format. Use DD/MM/YYYY (example: 25/12/2024).")
            sys.exit(1)

    if os.path.exists(args.dir):
        cleaner = ForensicCleaner(
            args.dir,
            delete_files=args.delete,
            force_self_destruct=args.force,
            wipe_mode=args.mode,
            rename=args.rename,
            clean_history_mode=args.clean,
            target_date=parsed_date
        )
        asyncio.run(cleaner.execute())
    else:
        print(f"[!] Target directory {args.dir} not found.")
