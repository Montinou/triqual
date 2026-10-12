# Fences plan

A fixture for the fence rule shared by progress-tracking's parsePlan and subagent-driven-development's task-brief:
a line indented four or more columns (a tab counts as four) never opens or closes a fence.

### Task 1: Backtick fence

**Role:** coordinator

```js
### Task 90: inside a backtick fence
**Depends on:** T9
```

### Task 2: Tilde fence closed by a longer run

**Depends on:** T1

~~~md
### Task 91: inside a tilde fence
~~~~~

### Task 3: A four-space-indented fence line is plain text

- a list item holding a fence:

    ```json
### Task 4: After a four-space-indented fence line

**Depends on:** T3

    ```

	```
### Task 5: After a tab-indented fence line

   ```
### Task 92: inside a fence indented three spaces
   ```

````
```
### Task 93: inside a longer fence, after a shorter run
    ````
	````
### Task 94: still inside, indented runs do not close it
````

### Task 6: Last

**Depends on:** T2, T5

~~~
### Task 95: inside a final tilde fence
~~~
