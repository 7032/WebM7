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

Note on the FM sound engine (`core/opn.js`): The FM synthesis portion of
this file is a JavaScript port of "FM Sound Generator" (fmgen),
Copyright (C) by cisc 1998, 2003. That portion is NOT covered by the MIT
License above; it is provided under the original fmgen terms, whose full
original text is included verbatim as `core/fmgen_readme.txt`. In summary:
the origin (author and copyright) must be stated; distribution must be as
free software; modifications must be clearly indicated; the original
readme must accompany any source distribution; and incorporation into
commercial software (including shareware) requires the author's prior
consent. Modifications in this port: translation from C++ to JavaScript,
reduction to the YM2203 (OPN) feature set, and integration with this
emulator's AudioWorklet output stage. The SSG section (`core/psg.js`) is
an independent implementation and remains under the MIT License.

Note on the cassette tape format (`core/cmt.js`): The fixed 16-byte header
string `XM7 TAPE IMAGE 0` is the format-level magic of the T77 file
format and is required for interoperability with existing T77 tooling.
Its presence in the source does not constitute a reference to, or a
dependency on, any specific third-party emulator project.
