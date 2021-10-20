class Node {
    constructor(value)
    {
        this.value = value;
        this.next = undefined;
    }
}

class Queue {
    constructor()
    {
        this.clear();}

    enqueue(value)
    {
        const node = new Node(value);

        if (this._head) {
            this._tail.next = node;
            this._tail = node;
        } else {
            this._head = node;
            this._tail = node;
        }

        this._size++;
    }

    dequeue()
    {
        const current = this._head;
        if (!current) {
            return;
        }

        this._head = this._head.next;
        this._size--;
        return current.value;
    }

    clear()
    {
        this._head = undefined;
        this._tail = undefined;
        this._size = 0;
    }

    get size()
    {
        return this._size;
    }

    * [Symbol.iterator]() {
        let current = this._head;

        while (current) {
            yield current.value;
            current = current.next;
        }
    }
}

module.exports = Queue;
