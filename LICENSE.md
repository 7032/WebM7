MIT License

Copyright (c) 2026 7032 / Naomitsu Tsugiiwa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

Note on the FM sound engine (`js/opn.js`): The envelope, detune, attack-curve
and related tables have been independently reconstructed from publicly
available YM2203 data-sheet and OPN application-manual specifications, to
the best of the author's knowledge, without incorporation of source code
from other emulator projects.

Note on the cassette tape format (`js/cmt.js`): The fixed 16-byte header
string `XM7 TAPE IMAGE 0` is the format-level magic of the T77 file
format and is required for interoperability with existing T77 tooling.
Its presence in the source does not constitute a reference to, or a
dependency on, any specific third-party emulator project.
